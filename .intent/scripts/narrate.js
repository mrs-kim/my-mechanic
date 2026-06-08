#!/usr/bin/env node

/**
 * intent narrate <id>
 *
 * Walks the requirement graph from any record ID and produces a
 * human-readable narrative of full context.
 *
 * Two modes:
 *   --mode=developer   (default) Why this requirement exists, what constrains it
 *   --mode=domain      Full domain overview — jobs, principles, decisions, active work
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(ROOT, "requirements");

const TYPE_DIRS = {
  job: "jobs",
  domain: "domains",
  "design-principle": "design-principles",
  "design-spec": "design-specs",
  requirement: "requirements",
  decision: "decisions",
};

// ─── Load all records ────────────────────────────────────────────────────────

const allRecords = new Map();

for (const [type, dir] of Object.entries(TYPE_DIRS)) {
  const fullDir = path.join(REQUIREMENTS_DIR, dir);
  if (!fs.existsSync(fullDir)) continue;
  const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of files) {
    try {
      const record = yaml.load(fs.readFileSync(path.join(fullDir, file), "utf8"));
      if (record?.id) allRecords.set(record.id, { record, type });
    } catch (e) {
      // skip malformed records
    }
  }
}

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const targetId = args.find((a) => !a.startsWith("--"));
const mode = args.find((a) => a.startsWith("--mode="))?.split("=")[1] || "developer";

if (!targetId) {
  console.error("Usage: intent narrate <id> [--mode=developer|domain]");
  process.exit(1);
}

const target = allRecords.get(targetId);
if (!target) {
  console.error(`No record found with ID: ${targetId}`);
  process.exit(1);
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function get(id) {
  return allRecords.get(id)?.record;
}

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(title.toUpperCase());
  console.log("─".repeat(60));
}

function field(label, value) {
  if (!value) return;
  if (Array.isArray(value) && value.length === 0) return;
  console.log(`\n${label}`);
  if (Array.isArray(value)) {
    value.forEach((v) => console.log(`  • ${v}`));
  } else {
    console.log(`  ${value.replace(/\n/g, "\n  ")}`);
  }
}

function recordLine(id) {
  const r = get(id);
  if (!r) return `  • ${id} (not found)`;
  const status = r.status?.legitimacy === "approved" ? "✓" : "○";
  return `  ${status} [${id}] ${r.title}`;
}

// ─── Developer mode ──────────────────────────────────────────────────────────

function narrateDeveloper(id) {
  const { record, type } = allRecords.get(id);

  section(`Context for ${id}`);
  console.log(`\nType:   ${type}`);
  console.log(`Title:  ${record.title}`);
  console.log(`Status: legitimacy=${record.status?.legitimacy}  lifecycle=${record.status?.lifecycle}${record.status?.implementation ? `  implementation=${record.status.implementation}` : ""}`);

  // Walk up to job
  section("Why this exists");
  const jobId = record.job || record.relationships?.parent && get(record.relationships.parent)?.job;
  if (jobId) {
    const job = get(jobId);
    if (job) {
      console.log(`\nServes job [${jobId}]: ${job.title}`);
      field("User need", job.narrative);
      field("Success looks like", job["success-looks-like"]);
    }
  }

  // The record itself
  section("What it does");
  if (record.behavior) field("Behavior", record.behavior);
  if (record.intent) field("Intent", record.intent);
  if (record.narrative) field("Narrative", record.narrative);
  if (record.rationale) field("Rationale", record.rationale);

  // Parent requirement
  if (record.relationships?.parent) {
    const parent = get(record.relationships.parent);
    if (parent) {
      section("Parent requirement");
      console.log(`\n[${record.relationships.parent}] ${parent.title}`);
      field("Behavior", parent.behavior);
    }
  }

  // Design constraints
  const designPrincipleId = record["design-principle"];
  if (designPrincipleId) {
    const dp = get(designPrincipleId);
    if (dp) {
      section("Design principle");
      console.log(`\n[${designPrincipleId}] ${dp.title}`);
      field("Intent", dp.intent);
      field("Avoid", dp["anti-patterns"]);
    }
  }

  // Relevant decisions
  const decisionIds = [
    ...(record.relationships?.depends_on || []).filter((id) => id.startsWith("dec_")),
    ...(record.relationships?.related || []).filter((id) => id.startsWith("dec_")),
  ];

  if (decisionIds.length > 0) {
    section("Relevant decisions");
    for (const decId of decisionIds) {
      const dec = get(decId);
      if (dec) {
        console.log(`\n[${decId}] ${dec.title}`);
        console.log(`  Outcome: ${dec.outcome}`);
        field("Rationale", dec.rationale);
        field("Revisit when", dec["revisit-when"]);
      }
    }
  }

  // Acceptance criteria
  if (record["acceptance-criteria"]?.length > 0) {
    section("Acceptance criteria");
    record["acceptance-criteria"].forEach((c, i) => {
      console.log(`\n  ${i + 1}. Given ${c.given}`);
      console.log(`     When  ${c.when}`);
      console.log(`     Then  ${c.then}`);
    });
  }

  // Implementation state
  if (record.traces?.length > 0 || record.tests?.length > 0) {
    section("Implementation");
    field("Traced to", record.traces);
    field("Tested by", record.tests);
  }
}

// ─── Domain mode ─────────────────────────────────────────────────────────────

function narrateDomain(id) {
  // If given a non-domain record, find its domain
  const { record, type } = allRecords.get(id);
  let domainId = type === "domain" ? id : record.domain;
  if (!domainId) {
    console.error(`Cannot determine domain for ${id}`);
    process.exit(1);
  }

  const domain = get(domainId);
  if (!domain) {
    console.error(`Domain not found: ${domainId}`);
    process.exit(1);
  }

  section(`Domain overview: ${domain.title}`);
  console.log(`\n[${domainId}]`);
  field("Description", domain.description);
  console.log(`\nOwner: ${domain["owner-team"]}`);
  field("Includes", domain.boundary?.includes);
  field("Excludes", domain.boundary?.excludes);

  // Jobs in this domain
  const jobs = [...allRecords.values()].filter(
    ({ record: r, type: t }) => t === "job" && r.domain === domainId
  );
  if (jobs.length > 0) {
    section("Jobs served");
    jobs.forEach(({ record: r }) => {
      const status = r.status?.legitimacy === "approved" ? "✓" : "○";
      console.log(`\n  ${status} [${r.id}] ${r.title}`);
      if (r.narrative) console.log(`     ${r.narrative.trim().slice(0, 120)}...`);
    });
  }

  // Design principles in this domain
  const principles = [...allRecords.values()].filter(
    ({ record: r, type: t }) => t === "design-principle" && r.domain === domainId
  );
  if (principles.length > 0) {
    section("Design principles");
    principles.forEach(({ record: r }) => {
      console.log(`\n  [${r.id}] ${r.title}`);
      if (r.intent) console.log(`     ${r.intent.trim().slice(0, 120)}`);
    });
  }

  // Active requirements
  const activeReqs = [...allRecords.values()].filter(
    ({ record: r, type: t }) =>
      t === "requirement" &&
      r.domain === domainId &&
      r.status?.lifecycle === "active"
  );

  const approved = activeReqs.filter((r) => r.record.status?.legitimacy === "approved");
  const proposed = activeReqs.filter((r) => r.record.status?.legitimacy === "proposed");

  if (approved.length > 0) {
    section("Approved requirements");
    approved.forEach(({ record: r }) => {
      const impl = r.status?.implementation;
      const implLabel = impl === "complete" ? "✓" : impl === "partial" ? "◑" : "○";
      console.log(`\n  ${implLabel} [${r.id}] ${r.title}`);
      console.log(`     implementation: ${impl}`);
    });
  }

  if (proposed.length > 0) {
    section("Proposed (pending approval)");
    proposed.forEach(({ record: r }) => {
      console.log(`  ○ [${r.id}] ${r.title}`);
    });
  }

  // Active decisions
  const decisions = [...allRecords.values()].filter(
    ({ record: r, type: t }) =>
      t === "decision" &&
      r.domain === domainId &&
      r.status?.lifecycle === "active" &&
      r.status?.legitimacy === "approved"
  );

  if (decisions.length > 0) {
    section("Active decisions");
    decisions.forEach(({ record: r }) => {
      console.log(`\n  [${r.id}] ${r.title}`);
      console.log(`     Outcome: ${r.outcome}`);
      if (r["revisit-when"]) console.log(`     Revisit: ${r["revisit-when"].trim().slice(0, 100)}`);
    });
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

if (mode === "domain") {
  narrateDomain(targetId);
} else {
  narrateDeveloper(targetId);
}

console.log("\n");
