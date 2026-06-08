#!/usr/bin/env node

/**
 * intent validate
 *
 * Runs the same checks as CI locally.
 * Three gates:
 *   1. Schema validity — every record matches its JSON Schema
 *   2. Graph integrity — every ID reference points to a real record
 *   3. Enforcement — approved+active requirements have traces (warning if unbuilt)
 */

const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const yaml = require("js-yaml");

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(ROOT, "requirements");
const SCHEMAS_DIR = path.join(ROOT, "schemas");

const TYPE_DIRS = {
  job: "jobs",
  domain: "domains",
  "design-principle": "design-principles",
  "design-spec": "design-specs",
  requirement: "requirements",
  decision: "decisions",
};

let errors = [];
let warnings = [];
let allRecords = new Map(); // id -> record

// ─── Load and compile schemas ────────────────────────────────────────────────

const validators = {};
for (const [type, dir] of Object.entries(TYPE_DIRS)) {
  const schemaName = type === "design-principle"
    ? "design-principle.schema.json"
    : type === "design-spec"
    ? "design-spec.schema.json"
    : `${type}.schema.json`;
  const schemaPath = path.join(SCHEMAS_DIR, schemaName);
  if (!fs.existsSync(schemaPath)) {
    errors.push(`Missing schema file: schemas/${schemaName}`);
    continue;
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  validators[type] = ajv.compile(schema);
}

// ─── Load all records ────────────────────────────────────────────────────────

function loadDir(type, dir) {
  const fullDir = path.join(REQUIREMENTS_DIR, dir);
  if (!fs.existsSync(fullDir)) return;

  const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of files) {
    const filePath = path.join(fullDir, file);
    let record;
    try {
      record = yaml.load(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      errors.push(`[${file}] YAML parse error: ${e.message}`);
      continue;
    }

    if (!record || !record.id) {
      errors.push(`[${file}] Missing required field: id`);
      continue;
    }

    if (allRecords.has(record.id)) {
      errors.push(`[${file}] Duplicate ID: ${record.id} already exists`);
      continue;
    }

    allRecords.set(record.id, { record, file, type });
  }
}

for (const [type, dir] of Object.entries(TYPE_DIRS)) {
  loadDir(type, dir);
}

// ─── Gate 1: Schema validation ───────────────────────────────────────────────

console.log("\n── Gate 1: Schema validation ──────────────────────────");

for (const [id, { record, file, type }] of allRecords) {
  const validate = validators[type];
  if (!validate) continue;

  const valid = validate(record);
  if (!valid) {
    for (const err of validate.errors) {
      errors.push(`[${file}] ${err.instancePath || "root"}: ${err.message}`);
    }
  }
}

const schemaErrors = errors.filter((e) => !e.startsWith("[") || true);
if (errors.length === 0) {
  console.log("  ✓ All records valid");
} else {
  errors.forEach((e) => console.log(`  ✗ ${e}`));
}

// ─── Gate 2: Graph integrity ─────────────────────────────────────────────────

console.log("\n── Gate 2: Graph integrity ─────────────────────────────");

const graphErrors = [];

function checkRef(fromFile, field, id) {
  if (!id) return;
  if (!allRecords.has(id)) {
    graphErrors.push(`[${fromFile}] ${field} references unknown ID: ${id}`);
  }
}

function checkRefs(fromFile, field, ids) {
  if (!ids) return;
  for (const id of ids) checkRef(fromFile, field, id);
}

for (const [id, { record, file }] of allRecords) {
  const r = record.relationships || {};
  checkRef(file, "relationships.parent", r.parent);
  checkRef(file, "relationships.supersedes", r.supersedes);
  checkRefs(file, "relationships.depends_on", r.depends_on);
  checkRefs(file, "relationships.conflicts_with", r.conflicts_with);
  checkRefs(file, "relationships.resolves", r.resolves);
  checkRefs(file, "relationships.constrains", r.constrains);
  checkRefs(file, "relationships.informs", r.informs);
  checkRefs(file, "relationships.related", r.related);

  if (record.domain) checkRef(file, "domain", record.domain);
  if (record.job) checkRef(file, "job", record.job);
  if (record.requirement) checkRef(file, "requirement", record.requirement);
  if (record["design-principle"]) checkRef(file, "design-principle", record["design-principle"]);

  const s = record.status || {};
  if (s["superseded-by"]) checkRef(file, "status.superseded-by", s["superseded-by"]);
}

if (graphErrors.length === 0) {
  console.log("  ✓ All references resolve");
} else {
  graphErrors.forEach((e) => {
    console.log(`  ✗ ${e}`);
    errors.push(e);
  });
}

// ─── Gate 3: Enforcement ─────────────────────────────────────────────────────

console.log("\n── Gate 3: Enforcement ─────────────────────────────────");

const enforcementIssues = [];

for (const [id, { record, file, type }] of allRecords) {
  if (type !== "requirement") continue;

  const s = record.status || {};
  const isEnforced = s.legitimacy === "approved" && s.lifecycle === "active";
  if (!isEnforced) continue;

  // Approved+active requirements must have a job
  if (!record.job) {
    errors.push(`[${file}] Approved requirement missing required field: job`);
  }

  // Warn if unbuilt with no traces — not a hard error, but surfaced
  if (s.implementation === "unbuilt" && (!record.traces || record.traces.length === 0)) {
    warnings.push(`[${file}] ${id}: approved+active but implementation=unbuilt and no traces. Is this intentional?`);
  }

  // Approved+active requirements should have at least one acceptance criterion
  if (!record["acceptance-criteria"] || record["acceptance-criteria"].length === 0) {
    warnings.push(`[${file}] ${id}: approved+active but has no acceptance criteria. Test agent has not run.`);
  }
}

// Check for conflicting approved+active requirements
const approvedActive = [...allRecords.values()].filter(
  ({ record, type }) =>
    type === "requirement" &&
    record.status?.legitimacy === "approved" &&
    record.status?.lifecycle === "active"
);

for (const { record, file } of approvedActive) {
  const conflicts = record.relationships?.conflicts_with || [];
  for (const conflictId of conflicts) {
    const other = allRecords.get(conflictId);
    if (
      other &&
      other.record.status?.legitimacy === "approved" &&
      other.record.status?.lifecycle === "active"
    ) {
      errors.push(
        `[${file}] ${record.id} conflicts_with ${conflictId} but both are approved+active. Decision required.`
      );
    }
  }
}

if (enforcementIssues.length === 0 && errors.filter(e => e.includes("conflicts_with")).length === 0) {
  console.log("  ✓ No enforcement violations");
}

// ─── Design system gap check ─────────────────────────────────────────────────

const gapRecords = [...allRecords.values()].filter(
  ({ record, type }) => type === "design-spec" && record["design-system-gap"] === true
);

if (gapRecords.length > 0) {
  console.log("\n── Design system gaps (informational) ──────────────────");
  gapRecords.forEach(({ record, file }) => {
    warnings.push(`[${file}] ${record.id}: no design system component match. Label: design-system-gap`);
  });
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n── Summary ──────────────────────────────────────────────");
console.log(`  Records loaded:  ${allRecords.size}`);
console.log(`  Errors:          ${errors.length}`);
console.log(`  Warnings:        ${warnings.length}`);

if (warnings.length > 0) {
  console.log("\nWarnings:");
  warnings.forEach((w) => console.log(`  ⚠  ${w}`));
}

if (errors.length > 0) {
  console.log("\nErrors:");
  errors.forEach((e) => console.log(`  ✗  ${e}`));
  console.log("\n✗ Validation failed\n");
  process.exit(1);
} else {
  console.log("\n✓ Validation passed\n");
  process.exit(0);
}
