#!/usr/bin/env node
"use strict";

/**
 * ingest-agent.js
 *
 * Ingests existing documentation into the requirement harness.
 * Works domain-by-domain. Opens one PR per domain for human review.
 *
 * Usage:
 *   node ingest-agent.js --from=./docs/
 *   node ingest-agent.js --from=./spec.md,./notes.txt
 *   node ingest-agent.js --from=https://notion.so/your-page
 *   cat spec.md | node ingest-agent.js
 *
 * Flags:
 *   --from=<sources>      Comma-separated files, dirs, or URLs
 *   --domain=<name>       Process only this domain (skip domain ID step)
 *   --dry-run             Extract and print, don't commit or open PRs
 *   --no-pr               Write files locally, don't open PRs
 *
 * Environment:
 *   INTENT_ROOT          path to repo root
 *   ANTHROPIC_API_KEY     Claude API key
 *   GITHUB_TOKEN          for opening PRs
 *   GITHUB_REPOSITORY     owner/repo
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const yaml = require("js-yaml");

const { fetchSources, fetchStdin, summarizeForDomainId } = require("./lib/fetcher");
const { identifyDomains, extractForDomain, reconcile, summarizeExtraction } = require("./lib/extractor");
const { Graph } = require("./lib/graph");
const github = require("./lib/github");
const { generateId } = require("./lib/ids");

const INTENT_ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(INTENT_ROOT, "requirements");
const TODAY = new Date().toISOString().split("T")[0];

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { sources: [], flags: {} };
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith("--from=")) {
      args.sources = arg.replace("--from=", "").split(",").map((s) => s.trim());
    } else if (arg.startsWith("--domain=")) {
      args.flags.domain = arg.replace("--domain=", "");
    } else if (arg === "--dry-run") {
      args.flags.dryRun = true;
    } else if (arg === "--no-pr") {
      args.flags.noPr = true;
    }
  });
  return args;
}

// ─── Interactive domain review ────────────────────────────────────────────────

async function reviewDomains(proposed) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log("\n── Proposed domains ─────────────────────────────────────\n");
  proposed.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.title}`);
    console.log(`     ${d.description}`);
    if (d.signals?.length) {
      console.log(`     Signals: ${d.signals.slice(0, 3).join(", ")}`);
    }
    console.log();
  });

  const answer = await ask(
    "Does this look right? (yes / remove <n> / add <name: description> / skip) "
  );

  rl.close();

  const trimmed = answer.trim().toLowerCase();

  if (trimmed === "yes" || trimmed === "y" || trimmed === "") {
    return proposed;
  }

  if (trimmed === "skip") {
    return proposed; // proceed without confirmation
  }

  if (trimmed.startsWith("remove ")) {
    const idx = parseInt(trimmed.replace("remove ", "")) - 1;
    if (idx >= 0 && idx < proposed.length) {
      const removed = proposed.splice(idx, 1)[0];
      console.log(`  Removed: ${removed.title}`);
    }
    return reviewDomains(proposed); // recurse for more edits
  }

  if (trimmed.startsWith("add ")) {
    const rest = answer.trim().slice(4);
    const colonIdx = rest.indexOf(":");
    if (colonIdx > 0) {
      proposed.push({
        title: rest.slice(0, colonIdx).trim(),
        description: rest.slice(colonIdx + 1).trim(),
        signals: [],
      });
    }
    return reviewDomains(proposed);
  }

  return proposed;
}

// ─── YAML record builders ─────────────────────────────────────────────────────

function buildDomainRecord(proposed, domainId) {
  return {
    id: domainId,
    type: "domain",
    title: proposed.title,
    description: proposed.description,
    "owner-team": "TBD — assign after review",
    boundary: {
      includes: proposed.signals?.slice(0, 5) || ["Edit this list"],
      excludes: [],
    },
    status: { lifecycle: "active" },
    meta: { created: TODAY, updated: TODAY },
  };
}

function buildJobRecord(extracted, domainId, jobId) {
  const record = {
    id: jobId,
    type: "job",
    title: extracted.title,
    domain: domainId,
    narrative: extracted.narrative,
    "success-looks-like": extracted["success-looks-like"] || "TBD",
    "out-of-scope": [],
    status: { legitimacy: "proposed", lifecycle: "active" },
    meta: {
      created: TODAY,
      updated: TODAY,
      "authored-by": "ingest-agent",
      "ingestion-confidence": extracted.confidence,
    },
  };

  if (extracted["confidence-note"]) {
    record.meta["ingestion-note"] = extracted["confidence-note"];
  }
  if (extracted["source-hint"]) {
    record.meta["ingestion-source"] = extracted["source-hint"];
  }

  return record;
}

function buildRequirementRecord(extracted, domainId, domainJobId, reqId) {
  const record = {
    id: reqId,
    type: "requirement",
    title: extracted.title,
    domain: domainId,
    job: domainJobId, // link to primary job — may need human correction
    behavior: extracted.behavior,
    status: {
      legitimacy: "proposed",
      lifecycle: "active",
      implementation: "unbuilt",
    },
    meta: {
      created: TODAY,
      updated: TODAY,
      "authored-by": "ingest-agent",
      "ingestion-confidence": extracted.confidence,
    },
  };

  if (extracted.rationale) record.rationale = extracted.rationale;
  if (extracted["confidence-note"]) {
    record.meta["ingestion-note"] = extracted["confidence-note"];
  }
  if (extracted["source-hint"]) {
    record.meta["ingestion-source"] = extracted["source-hint"];
  }

  return record;
}

function buildDecisionRecord(extracted, domainId, decId) {
  const record = {
    id: decId,
    type: "decision",
    title: extracted.title,
    domain: domainId,
    outcome: extracted.outcome,
    rationale: extracted.rationale || "See source documentation",
    "revisit-when": extracted["revisit-when"] || "TBD — add a revisit condition before approving",
    status: { legitimacy: "proposed", lifecycle: "active" },
    meta: {
      created: TODAY,
      updated: TODAY,
      "authored-by": "ingest-agent",
      "ingestion-confidence": extracted.confidence,
    },
  };

  if (extracted["confidence-note"]) {
    record.meta["ingestion-note"] = extracted["confidence-note"];
  }
  if (extracted["source-hint"]) {
    record.meta["ingestion-source"] = extracted["source-hint"];
  }

  return record;
}

function buildDesignPrincipleRecord(extracted, domainId, dpId) {
  const record = {
    id: dpId,
    type: "design-principle",
    title: extracted.title,
    domain: domainId,
    intent: extracted.intent,
    "anti-patterns": extracted["anti-patterns"] || [],
    "owner-team": "design-team",
    status: { legitimacy: "proposed", lifecycle: "active" },
    meta: {
      created: TODAY,
      updated: TODAY,
      "authored-by": "ingest-agent",
      "ingestion-confidence": extracted.confidence,
    },
  };

  if (extracted["confidence-note"]) {
    record.meta["ingestion-note"] = extracted["confidence-note"];
  }

  return record;
}

// ─── File writing ─────────────────────────────────────────────────────────────

function recordToYaml(record) {
  return yaml.dump(record, { lineWidth: 120, noRefs: true, quotingType: '"' });
}

function writeRecord(record, type, dryRun = false) {
  const typeDirs = {
    job: "jobs",
    domain: "domains",
    "design-principle": "design-principles",
    "design-spec": "design-specs",
    requirement: "requirements",
    decision: "decisions",
  };

  const dir = path.join(REQUIREMENTS_DIR, typeDirs[type]);
  const filePath = path.join(dir, `${record.id}.yaml`);
  const content = recordToYaml(record);

  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }

  return { path: `requirements/${typeDirs[type]}/${record.id}.yaml`, content };
}

// ─── PR creation ──────────────────────────────────────────────────────────────

async function openDomainPR(domainTitle, files, summary, domainId) {
  const branchName = `harness/ingest-${domainTitle.toLowerCase().replace(/\s+/g, "-")}-${TODAY.replace(/-/g, "")}`;

  const defaultBranch = await github.getDefaultBranch();
  try {
    const ref = await github.getRef(defaultBranch);
    await github.createBranch(branchName, ref.object.sha);
  } catch (e) {
    if (!e.message.includes("422")) throw e;
  }

  await github.commitFiles(
    files,
    `feat: ingest ${domainTitle} domain records [ingest-agent]`,
    branchName
  );

  const lowConfidenceSection =
    summary.lowConfidence.length > 0
      ? [
          "## ⚠ Low confidence records — review carefully",
          "",
          "These records were inferred or found contradictory in the source documentation.",
          "Verify them before merging, or remove them if they're wrong.",
          "",
          ...summary.lowConfidence.map(
            (r) => `- **${r.title}**${r.note ? ` — ${r.note}` : ""}`
          ),
          "",
        ].join("\n")
      : "";

  const unresolvedSection =
    summary.unresolved.length > 0
      ? [
          "## ❓ Unresolved contradictions",
          "",
          "These were captured as decision records with `outcome: unresolved`.",
          "The source documentation contradicted itself on these points.",
          "A human needs to resolve them before they can be approved.",
          "",
          ...summary.unresolved.map((r) => `- **${r.title}**: ${r.rationale}`),
          "",
        ].join("\n")
      : "";

  const prBody = [
    `## Ingested records — ${domainTitle} domain`,
    "",
    `Extracted from existing documentation by the ingest agent on ${TODAY}.`,
    "",
    `**Records proposed:**`,
    `- ${summary.counts.jobs} job(s)`,
    `- ${summary.counts.requirements} requirement(s)`,
    `- ${summary.counts.decisions} decision(s)`,
    `- ${summary.counts.principles} design principle(s)`,
    "",
    lowConfidenceSection,
    unresolvedSection,
    "## Review instructions",
    "",
    "**Every record in this PR is `legitimacy: proposed`.** Nothing becomes canonical until you merge.",
    "",
    "Work through the records and for each one:",
    "- [ ] Does the title accurately describe the behavior or decision?",
    "- [ ] Is the content what you actually decided — or what you're still figuring out?",
    "- [ ] Are low-confidence records correct? Remove or correct them if not.",
    "- [ ] Do decision records have a meaningful `revisit-when` condition?",
    "- [ ] Do requirements correctly link to a job?",
    "",
    "It's expected that you'll edit, remove, or split some records.",
    "The agent got you 70% of the way — you take it the rest.",
    "",
    "**You are the accountable human. Merging is your approval.**",
    "",
    "## Requirement records",
    files.filter((f) => f.path.includes("/requirements/")).map((f) => {
      const id = path.basename(f.path, ".yaml");
      return `- ${id}`;
    }).join("\n") || "none",
    "",
    "## Design review",
    "- [ ] No — ingestion PRs don't require design review",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const pr = await github.createPR(
    `feat: ingest ${domainTitle} domain records`,
    prBody,
    branchName
  );

  return pr;
}

// ─── Domain processing ────────────────────────────────────────────────────────

async function processDomain(domain, documents, graph, domainId, flags) {
  console.log(`\n── Extracting: ${domain.title} ─────────────────────────────\n`);

  // Get existing approved records for this domain (don't re-extract)
  const existingApproved = graph.all("requirement").filter(
    (r) =>
      r.domain === domainId &&
      r.status?.legitimacy === "approved" &&
      r.status?.lifecycle === "active"
  );

  const existingGraphSummary =
    existingApproved.length > 0
      ? `Existing approved requirements:\n${existingApproved.map((r) => `- ${r.title}`).join("\n")}`
      : "";

  // Extract from each document's chunks
  const allExtractions = [];

  for (const doc of documents) {
    console.log(`  Processing: ${doc.source} (${doc.chunks.length} chunk(s))`);

    const docExtractions = [];
    for (let i = 0; i < doc.chunks.length; i++) {
      process.stdout.write(`    Chunk ${i + 1}/${doc.chunks.length}... `);
      try {
        const extracted = await extractForDomain(domain, doc.chunks[i], existingGraphSummary);
        docExtractions.push(extracted);
        const count =
          (extracted.jobs?.length || 0) +
          (extracted.requirements?.length || 0) +
          (extracted.decisions?.length || 0) +
          (extracted.design_principles?.length || 0);
        console.log(`✓ ${count} records`);
      } catch (e) {
        console.log(`✗ ${e.message.slice(0, 60)}`);
        docExtractions.push({ jobs: [], requirements: [], decisions: [], design_principles: [] });
      }

      // Brief pause between chunks to avoid rate limiting
      if (i < doc.chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    allExtractions.push(...docExtractions);
  }

  // Reconcile across all chunks
  console.log(`\n  Reconciling ${allExtractions.length} extraction(s)...`);
  const reconciled = await reconcile(allExtractions);

  const counts = {
    jobs: (reconciled.jobs || []).length,
    requirements: (reconciled.requirements || []).length,
    decisions: (reconciled.decisions || []).length,
    principles: (reconciled.design_principles || []).length,
  };

  console.log(`  Results: ${counts.jobs} jobs, ${counts.requirements} reqs, ${counts.decisions} decisions, ${counts.principles} principles`);

  if (Object.values(counts).every((c) => c === 0)) {
    console.log(`  Nothing extracted for ${domain.title} — skipping`);
    return null;
  }

  // Build records with real IDs
  const files = [];

  // Domain record (only if it doesn't exist yet)
  const existingDomain = graph.get(domainId);
  if (!existingDomain) {
    const domainRecord = buildDomainRecord(domain, domainId);
    files.push(writeRecord(domainRecord, "domain", flags.dryRun));
  }

  // Jobs
  const jobIds = [];
  for (const extracted of reconciled.jobs || []) {
    const jobId = generateId("job");
    const record = buildJobRecord(extracted, domainId, jobId);
    files.push(writeRecord(record, "job", flags.dryRun));
    jobIds.push(jobId);
  }

  // Use first job ID as the anchor for requirements
  // Human will correct these links during review
  const primaryJobId = jobIds[0] || null;

  // Requirements
  for (const extracted of reconciled.requirements || []) {
    const reqId = generateId("requirement");
    const record = buildRequirementRecord(extracted, domainId, primaryJobId, reqId);
    if (!primaryJobId) delete record.job; // don't set a wrong job
    files.push(writeRecord(record, "requirement", flags.dryRun));
  }

  // Decisions
  for (const extracted of reconciled.decisions || []) {
    const decId = generateId("decision");
    const record = buildDecisionRecord(extracted, domainId, decId);
    files.push(writeRecord(record, "decision", flags.dryRun));
  }

  // Design principles
  for (const extracted of reconciled.design_principles || []) {
    const dpId = generateId("design-principle");
    const record = buildDesignPrincipleRecord(extracted, domainId, dpId);
    files.push(writeRecord(record, "design-principle", flags.dryRun));
  }

  const summary = await summarizeExtraction(domain.title, reconciled);

  return { files, summary, counts, domainId };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!process.env.ANTHROPIC_API_KEY && !process.env.INTENT_API_KEY) {
    console.error("ANTHROPIC_API_KEY (or INTENT_API_KEY) is required");
    process.exit(1);
  }

  console.log("\n══ Intent Harness — Ingest ═══════════════════════════════\n");

  // Read input
  const sources = args.sources;
  const stdinDoc = await fetchStdin();

  if (sources.length === 0 && !stdinDoc) {
    console.error(
      "No input provided. Use --from=<sources> or pipe content via stdin.\n" +
      "Examples:\n" +
      "  intent ingest --from=./docs/\n" +
      "  intent ingest --from=./spec.md,./notes.txt\n" +
      "  cat spec.md | intent ingest"
    );
    process.exit(1);
  }

  console.log("── Reading documents ─────────────────────────────────────\n");

  let documents = [];
  if (sources.length > 0) {
    documents = await fetchSources(sources);
  }
  if (stdinDoc) {
    documents.push(stdinDoc);
  }

  if (documents.length === 0) {
    console.error("No readable content found in provided sources.");
    process.exit(1);
  }

  const totalChars = documents.reduce((sum, d) => sum + d.content.length, 0);
  console.log(`\n  ${documents.length} document(s), ${totalChars.toLocaleString()} characters total`);

  // Load existing graph
  const graph = new Graph(REQUIREMENTS_DIR);
  console.log(`  ${graph.records.size} existing records in graph`);

  // Pass 1: Identify domains
  console.log("\n── Identifying domains ───────────────────────────────────\n");

  let domains;

  if (args.flags.domain) {
    // User specified a domain — skip identification
    domains = [{ title: args.flags.domain, description: args.flags.domain, signals: [] }];
    console.log(`  Using specified domain: ${args.flags.domain}`);
  } else {
    const summary = summarizeForDomainId(documents);

    process.stdout.write("  Analyzing documentation... ");
    domains = await identifyDomains(summary);
    console.log(`✓ ${domains.length} domains identified`);

    // Interactive review (skip if not a TTY or dry-run)
    if (process.stdin.isTTY && !args.flags.dryRun) {
      domains = await reviewDomains(domains);
    } else {
      console.log("\n  Proposed domains:");
      domains.forEach((d) => console.log(`    - ${d.title}: ${d.description}`));
      console.log("\n  (Non-interactive mode — proceeding without confirmation)");
    }
  }

  console.log(`\n  Processing ${domains.length} domain(s)\n`);

  // Pass 2 + 3: Extract and reconcile per domain
  const results = [];
  const allPRs = [];

  for (const domain of domains) {
    // Check if domain already exists in graph
    const existingDomain = graph
      .all("domain")
      .find((d) => d.title.toLowerCase() === domain.title.toLowerCase());

    const domainId = existingDomain?.id || generateId("domain");

    if (existingDomain) {
      console.log(`  Using existing domain: ${domainId} (${domain.title})`);
    }

    const result = await processDomain(domain, documents, graph, domainId, args.flags);

    if (!result) continue;
    results.push(result);

    if (args.flags.dryRun) {
      console.log(`\n  [dry-run] Would commit ${result.files.length} files for ${domain.title}`);
      continue;
    }

    if (!args.flags.noPr && process.env.GITHUB_TOKEN) {
      try {
        process.stdout.write(`\n  Opening PR for ${domain.title}... `);
        const pr = await openDomainPR(domain.title, result.files, result.summary, domainId);
        console.log(`✓ ${pr.html_url}`);
        allPRs.push({ domain: domain.title, pr });
      } catch (e) {
        console.log(`✗ ${e.message.slice(0, 80)}`);
        console.log(`  Files written locally — commit and push manually.`);
      }
    } else {
      console.log(`\n  Files written locally for ${domain.title}.`);
    }

    // Pause between domains to avoid rate limiting
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Final report
  console.log("\n══ Ingestion complete ══════════════════════════════════════\n");

  const totalCounts = results.reduce(
    (acc, r) => ({
      jobs: acc.jobs + r.counts.jobs,
      requirements: acc.requirements + r.counts.requirements,
      decisions: acc.decisions + r.counts.decisions,
      principles: acc.principles + r.counts.principles,
    }),
    { jobs: 0, requirements: 0, decisions: 0, principles: 0 }
  );

  console.log("  Records proposed:");
  console.log(`    Jobs:               ${totalCounts.jobs}`);
  console.log(`    Requirements:       ${totalCounts.requirements}`);
  console.log(`    Decisions:          ${totalCounts.decisions}`);
  console.log(`    Design principles:  ${totalCounts.principles}`);

  const allLowConfidence = results.flatMap((r) => r.summary.lowConfidence);
  const allUnresolved = results.flatMap((r) => r.summary.unresolved);

  if (allLowConfidence.length > 0) {
    console.log(`\n  ⚠ ${allLowConfidence.length} low-confidence record(s) need careful review`);
  }
  if (allUnresolved.length > 0) {
    console.log(`  ❓ ${allUnresolved.length} unresolved contradiction(s) need human resolution`);
  }

  if (allPRs.length > 0) {
    console.log("\n  PRs opened:");
    allPRs.forEach(({ domain, pr }) => console.log(`    ${domain}: ${pr.html_url}`));
  }

  console.log(`
  Next steps:
    1. Review each PR carefully — especially low-confidence records
    2. Edit, remove, or split records that aren't right
    3. Ensure every requirement links to a job
    4. Add revisit-when conditions to any decision records missing them
    5. Merge what's correct — that's your approval
    6. Run: intent validate   to confirm all records are well-formed
`);
}

main().catch((e) => {
  console.error(`\nIngest agent error: ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
