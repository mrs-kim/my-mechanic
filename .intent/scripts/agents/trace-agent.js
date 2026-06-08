#!/usr/bin/env node
"use strict";

/**
 * trace-agent.js
 *
 * Scans source code for requirement annotation comments,
 * builds a traceability map, updates requirement records,
 * and reports gaps and orphans.
 *
 * Annotation format (any language):
 *   // req: req_cv3p8x
 *   # req: req_cv3p8x
 *   -- req: req_cv3p8x
 *   /* req: req_cv3p8x *\/
 *
 * Multiple annotations per file are supported.
 * One annotation can appear multiple times (same req, different files).
 *
 * Usage:
 *   node trace-agent.js --mode=full
 *   node trace-agent.js --mode=pr --files="src/foo.ts src/bar.ts"
 *   node trace-agent.js --mode=report
 *
 * Modes:
 *   full    Scan all configured source files, update all records, write trace.json
 *   pr      Scan only changed files, report gaps without writing to records
 *   report  Read existing trace.json and report — no scanning
 *
 * Environment:
 *   INTENT_ROOT        path to repo root (defaults to cwd)
 *   GITHUB_TOKEN        for posting PR comments
 *   GITHUB_REPOSITORY   owner/repo
 *   PR_NUMBER           for pr mode
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { Graph } = require("./lib/graph");
const github = require("./lib/github");

const INTENT_ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(INTENT_ROOT, "requirements");
const TRACE_FILE = path.join(INTENT_ROOT, ".intent", "trace.json");
const TODAY = new Date().toISOString().split("T")[0];

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { files: [] };
  process.argv.slice(2).forEach((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    const val = rest.join("=");
    if (key === "files") {
      args.files = val.split(" ").filter(Boolean);
    } else {
      args[key] = val || true;
    }
  });
  return args;
}

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = path.join(INTENT_ROOT, "intent.config.yml");
  if (!fs.existsSync(configPath)) {
    return {
      include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "src/**/*.py"],
      exclude: ["**/*.test.*", "**/*.spec.*", "**/node_modules/**"],
    };
  }
  try {
    const config = yaml.load(fs.readFileSync(configPath, "utf8"));
    return config?.agents?.trace || {};
  } catch {
    return {};
  }
}

// ─── File scanning ────────────────────────────────────────────────────────────

// Matches: // req: req_abc123, # req: req_abc123, -- req: req_abc123
const ANNOTATION_PATTERN = /(?:\/\/|#|--|\/\*)\s*req:\s*(req_[a-z0-9]{6,12})/g;

/**
 * Scans a single file for req: annotations.
 * Returns array of requirement IDs found.
 */
function scanFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const ids = new Set();
    let match;
    const pattern = new RegExp(ANNOTATION_PATTERN.source, "g");
    while ((match = pattern.exec(content)) !== null) {
      ids.add(match[1]);
    }
    return [...ids];
  } catch {
    return [];
  }
}

/**
 * Recursively finds all source files matching include patterns,
 * respecting exclude patterns from config.
 *
 * Uses simple glob-like matching without external dependencies.
 */
function findSourceFiles(root, include, exclude) {
  const results = [];

  function matchesPattern(filePath, patterns) {
    const rel = path.relative(root, filePath);
    return patterns.some((pattern) => {
      // Convert glob to simple regex
      const regexStr = pattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "{{DOUBLE}}")
        .replace(/\*/g, "[^/]*")
        .replace(/{{DOUBLE}}/g, ".*");
      const regex = new RegExp(`^${regexStr}$`);
      return regex.test(rel);
    });
  }

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip excluded dirs early
        if (!matchesPattern(fullPath + "/index", exclude || [])) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (
          matchesPattern(fullPath, include || ["**/*"]) &&
          !matchesPattern(fullPath, exclude || [])
        ) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(root);
  return results;
}

// ─── Trace map ────────────────────────────────────────────────────────────────

/**
 * Builds the full traceability map.
 *
 * Returns:
 * {
 *   byRequirement: { req_id: [file1, file2, ...] },
 *   byFile:        { file: [req_id1, req_id2, ...] },
 *   orphans:       [{ file, reqId }],  // annotations pointing to non-existent reqs
 *   generated:     ISO timestamp
 * }
 */
function buildTraceMap(files, graph) {
  const byRequirement = {};
  const byFile = {};
  const orphans = [];

  for (const filePath of files) {
    const reqIds = scanFile(filePath);
    if (reqIds.length === 0) continue;

    const relPath = path.relative(INTENT_ROOT, filePath);
    byFile[relPath] = reqIds;

    for (const reqId of reqIds) {
      const exists = graph.get(reqId);
      if (!exists) {
        orphans.push({ file: relPath, reqId });
        continue;
      }
      if (!byRequirement[reqId]) byRequirement[reqId] = [];
      if (!byRequirement[reqId].includes(relPath)) {
        byRequirement[reqId].push(relPath);
      }
    }
  }

  return {
    byRequirement,
    byFile,
    orphans,
    generated: new Date().toISOString(),
  };
}

// ─── Record updates ───────────────────────────────────────────────────────────

/**
 * Updates requirement records with trace information.
 * Only updates `traces` and `status.implementation` fields.
 * Never touches any other field.
 */
function updateRequirementRecords(traceMap, graph) {
  const updated = [];

  for (const [reqId, files] of Object.entries(traceMap.byRequirement)) {
    const meta = graph.getWithMeta(reqId);
    if (!meta) continue;
    if (meta.type !== "requirement") continue;

    const record = meta.record;
    const filePath = path.join(INTENT_ROOT, "requirements", "requirements", `${reqId}.yaml`);

    if (!fs.existsSync(filePath)) continue;

    let changed = false;

    // Update traces
    const existingTraces = record.traces || [];
    const newTraces = [...new Set([...existingTraces, ...files])].sort();
    if (JSON.stringify(newTraces) !== JSON.stringify(existingTraces)) {
      record.traces = newTraces;
      changed = true;
    }

    // Update implementation status
    const currentImpl = record.status?.implementation;
    let newImpl = currentImpl;

    if (files.length > 0 && currentImpl === "unbuilt") {
      newImpl = "partial"; // traces exist but may not be complete
      changed = true;
    }

    if (changed) {
      if (record.status) record.status.implementation = newImpl;
      if (!record.meta) record.meta = {};
      record.meta.updated = TODAY;

      const content = yaml.dump(record, {
        lineWidth: 120,
        noRefs: true,
        quotingType: '"',
      });

      fs.writeFileSync(filePath, content, "utf8");
      updated.push({ reqId, traces: newTraces, implementation: newImpl });
    }
  }

  return updated;
}

// ─── Gap analysis ─────────────────────────────────────────────────────────────

/**
 * Finds approved+active requirements with no traces.
 * These are behavioral promises with no code backing them.
 */
function findCoverageGaps(traceMap, graph) {
  const gaps = [];

  for (const record of graph.all("requirement")) {
    if (record.status?.legitimacy !== "approved") continue;
    if (record.status?.lifecycle !== "active") continue;

    const traces = traceMap.byRequirement[record.id] || [];
    if (traces.length === 0) {
      gaps.push({
        id: record.id,
        title: record.title,
        implementation: record.status?.implementation,
        domain: record.domain,
      });
    }
  }

  return gaps;
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function formatSummary(traceMap, gaps, mode) {
  const lines = [];
  const reqCount = Object.keys(traceMap.byRequirement).length;
  const fileCount = Object.keys(traceMap.byFile).length;

  lines.push(`## Trace report (${mode} scan)`);
  lines.push(`Generated: ${traceMap.generated}`);
  lines.push("");
  lines.push(`**${reqCount}** requirements traced across **${fileCount}** files`);
  lines.push("");

  if (traceMap.orphans.length > 0) {
    lines.push("### ⚠ Orphaned annotations");
    lines.push(
      "These files contain `req:` annotations pointing to requirement IDs that don't exist."
    );
    lines.push("Either the ID is wrong or the requirement was superseded.");
    lines.push("");
    for (const { file, reqId } of traceMap.orphans) {
      lines.push(`- \`${file}\` → \`${reqId}\` (not found)`);
    }
    lines.push("");
  }

  if (gaps.length > 0) {
    lines.push("### ○ Coverage gaps");
    lines.push(
      "These approved+active requirements have no code traces. Expected behavior with no implementation backing it."
    );
    lines.push("");
    for (const gap of gaps) {
      const impl = gap.implementation === "unbuilt" ? "unbuilt" : gap.implementation;
      lines.push(`- \`${gap.id}\` ${gap.title} *(${impl})*`);
    }
    lines.push("");
    lines.push(
      "Add `// req: <id>` annotations in the implementing code, or mark as `implementation: unbuilt` intentionally."
    );
  }

  if (traceMap.orphans.length === 0 && gaps.length === 0) {
    lines.push("✓ All traces resolve. All approved+active requirements have code backing.");
  }

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const mode = args.mode || "full";
  const config = loadConfig();
  const graph = new Graph(REQUIREMENTS_DIR);
  const prNumber = process.env.PR_NUMBER ? parseInt(process.env.PR_NUMBER) : null;

  console.log(`\n── Trace agent (${mode} mode) ────────────────────────────\n`);

  let filesToScan = [];

  if (mode === "report") {
    // Read existing trace file and report — no scanning
    if (!fs.existsSync(TRACE_FILE)) {
      console.log("No trace.json found. Run with --mode=full first.");
      process.exit(0);
    }
    const traceMap = JSON.parse(fs.readFileSync(TRACE_FILE, "utf8"));
    const gaps = findCoverageGaps(traceMap, graph);
    console.log(formatSummary(traceMap, gaps, "cached"));
    process.exit(0);
  }

  if (mode === "pr") {
    // Only scan files explicitly passed (changed files in the PR)
    filesToScan = args.files
      .map((f) => path.join(INTENT_ROOT, f))
      .filter((f) => fs.existsSync(f));
    console.log(`Scanning ${filesToScan.length} changed files`);
  } else {
    // Full scan — find all source files matching config patterns
    filesToScan = findSourceFiles(
      INTENT_ROOT,
      config.include || ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js"],
      config.exclude || ["**/*.test.*", "**/*.spec.*", "**/node_modules/**"]
    );
    console.log(`Scanning ${filesToScan.length} source files`);
  }

  // Build trace map
  const traceMap = buildTraceMap(filesToScan, graph);

  console.log(`  Annotated files:   ${Object.keys(traceMap.byFile).length}`);
  console.log(`  Requirements hit:  ${Object.keys(traceMap.byRequirement).length}`);
  console.log(`  Orphaned refs:     ${traceMap.orphans.length}`);

  // Find gaps
  const gaps = findCoverageGaps(traceMap, graph);
  console.log(`  Coverage gaps:     ${gaps.length}`);

  // Write trace.json (full mode only — merge with existing in pr mode)
  if (mode === "full") {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    fs.writeFileSync(TRACE_FILE, JSON.stringify(traceMap, null, 2));
    console.log(`\n  ✓ Wrote trace.json`);

    // Update requirement records with new trace info
    const updated = updateRequirementRecords(traceMap, graph);
    if (updated.length > 0) {
      console.log(`\n  Updated records:`);
      updated.forEach(({ reqId, traces, implementation }) => {
        console.log(`    ${reqId}: traces=${traces.length}, implementation=${implementation}`);
      });
    }
  } else {
    // PR mode: merge new findings into existing trace map
    if (fs.existsSync(TRACE_FILE)) {
      const existing = JSON.parse(fs.readFileSync(TRACE_FILE, "utf8"));

      // Merge byFile and byRequirement
      Object.assign(existing.byFile, traceMap.byFile);
      for (const [reqId, files] of Object.entries(traceMap.byRequirement)) {
        if (!existing.byRequirement[reqId]) existing.byRequirement[reqId] = [];
        existing.byRequirement[reqId] = [
          ...new Set([...existing.byRequirement[reqId], ...files]),
        ];
      }
      existing.generated = traceMap.generated;

      fs.writeFileSync(TRACE_FILE, JSON.stringify(existing, null, 2));
    }
  }

  // Print report
  console.log("\n" + formatSummary(traceMap, gaps, mode));

  // Post to PR if in PR mode and there are issues
  if (mode === "pr" && prNumber && (traceMap.orphans.length > 0 || gaps.length > 0)) {
    try {
      const comment = [
        "## 🔍 Trace agent report",
        "",
        formatSummary(traceMap, gaps, "PR"),
        "",
        "---",
        "*This is informational — orphan annotations are a hard CI failure, coverage gaps are a warning.*",
      ].join("\n");

      await github.createIssueComment(prNumber, comment);
      console.log(`\n  ✓ Posted trace report to PR #${prNumber}`);
    } catch (e) {
      console.warn(`  Could not post to PR: ${e.message}`);
    }
  }

  // Hard fail if orphans exist — these are broken references
  if (traceMap.orphans.length > 0) {
    console.error(
      `\n✗ ${traceMap.orphans.length} orphaned annotation(s) found. Fix or remove them before merging.\n`
    );
    process.exit(1);
  }

  console.log("\n✓ Trace complete\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(`Trace agent error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
