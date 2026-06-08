#!/usr/bin/env node
"use strict";

/**
 * decision-agent.js
 *
 * Watches the requirement graph for situations that require human judgment.
 * Never resolves anything itself. Always escalates to humans via GitHub Issues.
 *
 * Three checks:
 *
 * 1. CONFLICT CHECK
 *    Two approved+active requirements with a conflicts_with relationship
 *    between them. Both cannot be true simultaneously — a human must resolve.
 *
 * 2. GAP CHECK
 *    Approved+active requirements that have been unbuilt longer than the
 *    configured threshold. Not a failure — but worth surfacing so it doesn't
 *    silently drift forever.
 *
 * 3. REVISIT CHECK
 *    Approved decisions with a revisit-when condition. Runs on schedule.
 *    Surfaces decisions that may need reconsideration based on age or
 *    changes to the graph since they were made.
 *
 * Usage:
 *   node decision-agent.js --check=conflicts
 *   node decision-agent.js --check=gaps
 *   node decision-agent.js --check=revisit
 *   node decision-agent.js --check=all
 *
 * Environment:
 *   INTENT_ROOT        path to repo root
 *   GITHUB_TOKEN        for opening issues
 *   GITHUB_REPOSITORY   owner/repo
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { Graph } = require("./lib/graph");
const github = require("./lib/github");

const INTENT_ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(INTENT_ROOT, "requirements");
const STATE_FILE = path.join(INTENT_ROOT, ".intent", "decision-agent-state.json");
const TODAY = new Date().toISOString().split("T")[0];

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    args[key] = val || true;
  });
  return args;
}

function loadConfig() {
  const configPath = path.join(INTENT_ROOT, "intent.config.yml");
  if (!fs.existsSync(configPath)) return { "unbuilt-warning-days": 30 };
  try {
    const config = yaml.load(fs.readFileSync(configPath, "utf8"));
    return {
      unbuiltWarningDays: config?.enforcement?.["unbuilt-warning-days"] ?? 30,
      issueLabel: config?.agents?.decision?.["issue-label"] ?? "decision-needed",
      warnOnly: config?.enforcement?.["warn-only"] ?? false,
    };
  } catch {
    return { unbuiltWarningDays: 30, issueLabel: "decision-needed", warnOnly: false };
  }
}

// ─── State management ─────────────────────────────────────────────────────────

/**
 * The decision agent tracks which issues it has already opened
 * to avoid opening duplicates on every run.
 *
 * State is stored in .intent/decision-agent-state.json
 * Keys: conflict:{id1}:{id2}, gap:{reqId}, revisit:{decId}:{year}
 */

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { openedIssues: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { openedIssues: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function alreadyOpened(state, key) {
  return !!state.openedIssues[key];
}

function markOpened(state, key, issueNumber) {
  state.openedIssues[key] = { issueNumber, date: TODAY };
}

// ─── Check 1: Conflicts ───────────────────────────────────────────────────────

/**
 * Finds pairs of approved+active requirements that conflict with each other.
 * A conflict means both cannot be true simultaneously — this is a human decision.
 */
function findConflicts(graph) {
  const conflicts = [];
  const seen = new Set();

  for (const record of graph.all("requirement")) {
    if (record.status?.legitimacy !== "approved") continue;
    if (record.status?.lifecycle !== "active") continue;

    const conflictIds = record.relationships?.conflicts_with || [];
    for (const otherId of conflictIds) {
      const other = graph.get(otherId);
      if (!other) continue;
      if (other.status?.legitimacy !== "approved") continue;
      if (other.status?.lifecycle !== "active") continue;

      // Avoid duplicating A-B and B-A
      const key = [record.id, otherId].sort().join(":");
      if (seen.has(key)) continue;
      seen.add(key);

      conflicts.push({ a: record, b: other, key: `conflict:${key}` });
    }
  }

  return conflicts;
}

async function handleConflicts(graph, state, config) {
  const conflicts = findConflicts(graph);

  if (conflicts.length === 0) {
    console.log("  ✓ No conflicts found");
    return 0;
  }

  let opened = 0;

  for (const { a, b, key } of conflicts) {
    if (alreadyOpened(state, key)) {
      console.log(`  ○ Conflict ${key} already has an open issue — skipping`);
      continue;
    }

    const domainA = graph.get(a.domain);
    const domainB = graph.get(b.domain);

    const issueBody = [
      "## Conflicting requirements",
      "",
      "Two approved+active requirements are marked as `conflicts_with` each other.",
      "Both cannot be true simultaneously. A human decision is required.",
      "",
      "---",
      "",
      `### [${a.id}] ${a.title}`,
      `Domain: ${domainA?.title || a.domain}`,
      "",
      "```",
      a.behavior,
      "```",
      "",
      `### [${b.id}] ${b.title}`,
      `Domain: ${domainB?.title || b.domain}`,
      "",
      "```",
      b.behavior,
      "```",
      "",
      "---",
      "",
      "### Resolution options",
      "",
      "1. **Supersede one** — mark the losing requirement as `legitimacy: superseded` and create a decision record explaining why",
      "2. **Clarify scope** — if they don't actually conflict, remove the `conflicts_with` relationship and document why they can coexist",
      "3. **Create a decision record** — if this is an intentional exclusion, record it as `dec_xxxxxxxx` with a revisit condition",
      "",
      "Close this issue after recording the resolution in the requirement system.",
      "",
      "---",
      "*Opened by the decision agent. The harness cannot resolve this — human judgment required.*",
    ].join("\n");

    try {
      const issue = await github.createIssue(
        `Decision needed: conflicting requirements ${a.id} ↔ ${b.id}`,
        issueBody,
        [config.issueLabel]
      );
      markOpened(state, key, issue.number);
      console.log(`  ✗ Opened conflict issue #${issue.number}: ${a.id} ↔ ${b.id}`);
      opened++;
    } catch (e) {
      console.warn(`  Could not open issue for conflict ${key}: ${e.message}`);
    }
  }

  return opened;
}

// ─── Check 2: Gaps ────────────────────────────────────────────────────────────

/**
 * Finds approved+active requirements that have been unbuilt longer than threshold.
 * Groups them by domain for a cleaner issue.
 */
function findStaleUnbuilt(graph, thresholdDays) {
  const stale = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - thresholdDays);

  for (const record of graph.all("requirement")) {
    if (record.status?.legitimacy !== "approved") continue;
    if (record.status?.lifecycle !== "active") continue;
    if (record.status?.implementation !== "unbuilt") continue;

    // Check approved date
    const approvedDate = record.meta?.["approved-date"];
    if (!approvedDate) {
      stale.push({ record, age: null });
      continue;
    }

    const approved = new Date(approvedDate);
    if (approved < cutoff) {
      const ageDays = Math.floor((new Date() - approved) / (1000 * 60 * 60 * 24));
      stale.push({ record, age: ageDays });
    }
  }

  return stale;
}

async function handleGaps(graph, state, config) {
  const stale = findStaleUnbuilt(graph, config.unbuiltWarningDays);

  if (stale.length === 0) {
    console.log(`  ✓ No unbuilt requirements older than ${config.unbuiltWarningDays} days`);
    return 0;
  }

  // Group by domain
  const byDomain = {};
  for (const { record, age } of stale) {
    const domainId = record.domain || "unknown";
    if (!byDomain[domainId]) byDomain[domainId] = [];
    byDomain[domainId].push({ record, age });
  }

  let opened = 0;

  for (const [domainId, items] of Object.entries(byDomain)) {
    // One issue per domain per week — avoid spamming
    const weekKey = `gap:${domainId}:${getWeekKey()}`;
    if (alreadyOpened(state, weekKey)) {
      console.log(`  ○ Gap issue for domain ${domainId} already opened this week`);
      continue;
    }

    const domain = graph.get(domainId);
    const domainTitle = domain?.title || domainId;

    const rows = items
      .map(({ record, age }) => {
        const ageStr = age ? `${age} days` : "unknown age";
        const job = record.job ? graph.get(record.job) : null;
        return `| \`${record.id}\` | ${record.title} | ${ageStr} | ${job?.title || "—"} |`;
      })
      .join("\n");

    const issueBody = [
      `## Unbuilt requirements — ${domainTitle}`,
      "",
      `These approved+active requirements in the **${domainTitle}** domain have been \`implementation: unbuilt\` for more than ${config.unbuiltWarningDays} days.`,
      "",
      "This is not necessarily a failure — requirements can be approved before implementation begins. But surfacing them prevents them from silently drifting.",
      "",
      "| ID | Title | Age | Job |",
      "|---|---|---|---|",
      rows,
      "",
      "### Actions",
      "",
      "- **If implementation is underway**: add `// req: <id>` annotations in the code. The trace agent will update status automatically.",
      "- **If this was intentionally deferred**: create a decision record (`dec_xxxxxxxx`) with `outcome: deferred` and a `revisit-when` condition.",
      "- **If the requirement is no longer needed**: mark it `lifecycle: historical` and document why.",
      "- **If this is expected (feature planned for next sprint)**: close this issue — it will reopen next week if still unbuilt.",
      "",
      "---",
      "*Opened by the decision agent. This is informational, not a blocker.*",
    ].join("\n");

    try {
      const issue = await github.createIssue(
        `Unbuilt requirements: ${domainTitle} (${items.length} pending)`,
        issueBody,
        [config.issueLabel, "gap"]
      );
      markOpened(state, weekKey, issue.number);
      console.log(
        `  ⚠ Opened gap issue #${issue.number}: ${items.length} unbuilt in ${domainTitle}`
      );
      opened++;
    } catch (e) {
      console.warn(`  Could not open gap issue for ${domainId}: ${e.message}`);
    }
  }

  return opened;
}

// ─── Check 3: Revisit ─────────────────────────────────────────────────────────

/**
 * Surfaces old decisions for potential reconsideration.
 * Runs on schedule (weekly/monthly). Only surfaces decisions
 * that are over 6 months old — avoids noise on new decisions.
 */
function findOldDecisions(graph, monthsOld = 6) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsOld);

  return graph.all("decision").filter((d) => {
    if (d.status?.legitimacy !== "approved") return false;
    if (d.status?.lifecycle !== "active") return false;
    if (!d["revisit-when"]) return false;

    const approvedDate = d.meta?.["approved-date"];
    if (!approvedDate) return false;

    return new Date(approvedDate) < cutoff;
  });
}

async function handleRevisit(graph, state, config) {
  const old = findOldDecisions(graph);

  if (old.length === 0) {
    console.log("  ✓ No decisions due for revisit");
    return 0;
  }

  let opened = 0;

  for (const decision of old) {
    const yearKey = `revisit:${decision.id}:${new Date().getFullYear()}`;
    if (alreadyOpened(state, yearKey)) {
      console.log(`  ○ Revisit issue for ${decision.id} already opened this year`);
      continue;
    }

    const domain = graph.get(decision.domain);
    const constrained = (decision.relationships?.constrains || [])
      .map((id) => {
        const r = graph.get(id);
        return r ? `- [${id}] ${r.title}` : `- ${id}`;
      })
      .join("\n");

    const approvedDate = decision.meta?.["approved-date"] || "unknown";
    const ageDays = approvedDate !== "unknown"
      ? Math.floor((new Date() - new Date(approvedDate)) / (1000 * 60 * 60 * 24))
      : null;

    const issueBody = [
      `## Decision revisit: ${decision.title}`,
      "",
      `This decision was approved on **${approvedDate}**${ageDays ? ` (${ageDays} days ago)` : ""} and is due for review.`,
      "",
      "---",
      "",
      `**Domain:** ${domain?.title || decision.domain}`,
      `**Outcome:** ${decision.outcome}`,
      "",
      "### Rationale (original)",
      decision.rationale,
      "",
      "### Revisit condition",
      `> ${decision["revisit-when"]}`,
      "",
      constrained
        ? `### Constrained requirements\n${constrained}\n`
        : "",
      "---",
      "",
      "### Actions",
      "",
      "- **If the decision still holds**: close this issue. It won't reopen until next year.",
      "- **If the condition has been met**: create a new decision record that supersedes this one, update any constrained requirements, and close this issue.",
      "- **If this is no longer relevant**: mark the decision `lifecycle: historical` and close.",
      "",
      "---",
      "*Opened by the decision agent on a scheduled review cycle.*",
    ].join("\n");

    try {
      const issue = await github.createIssue(
        `Decision revisit: ${decision.title}`,
        issueBody,
        [config.issueLabel, "revisit"]
      );
      markOpened(state, yearKey, issue.number);
      console.log(`  ⚠ Opened revisit issue #${issue.number}: ${decision.id}`);
      opened++;
    } catch (e) {
      console.warn(`  Could not open revisit issue for ${decision.id}: ${e.message}`);
    }
  }

  return opened;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function getWeekKey() {
  const d = new Date();
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const check = args.check || "all";
  const config = loadConfig();
  const graph = new Graph(REQUIREMENTS_DIR);
  const state = loadState();

  console.log(`\n── Decision agent (${check}) ──────────────────────────────\n`);
  console.log(`  Records in graph:       ${graph.records.size}`);
  console.log(`  Unbuilt warning days:   ${config.unbuiltWarningDays}`);
  console.log(`  Issue label:            ${config.issueLabel}`);
  console.log(`  Warn only mode:         ${config.warnOnly}`);
  console.log("");

  let totalIssues = 0;

  if (check === "conflicts" || check === "all") {
    console.log("── Conflict check ──────────────────────────────────────");
    totalIssues += await handleConflicts(graph, state, config);
  }

  if (check === "gaps" || check === "all") {
    console.log("\n── Gap check ───────────────────────────────────────────");
    totalIssues += await handleGaps(graph, state, config);
  }

  if (check === "revisit" || check === "all") {
    console.log("\n── Revisit check ───────────────────────────────────────");
    totalIssues += await handleRevisit(graph, state, config);
  }

  // Save updated state
  saveState(state);

  console.log(`\n── Summary ──────────────────────────────────────────────`);
  console.log(`  Issues opened: ${totalIssues}`);

  if (totalIssues > 0) {
    console.log("\n⚠ Issues opened — human attention required\n");
  } else {
    console.log("\n✓ No issues to open\n");
  }

  // In non-warn-only mode, exit with code 1 if conflicts found
  // (conflicts are always blockers; gaps and revisits are not)
  if (!config.warnOnly && check === "all") {
    const conflicts = findConflicts(graph);
    if (conflicts.length > 0) {
      process.exit(1);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(`Decision agent error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
