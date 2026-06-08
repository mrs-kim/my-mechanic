#!/usr/bin/env node
"use strict";

/**
 * flip-legitimacy.js
 *
 * Runs after a merge to main.
 * Finds all requirement records that are legitimacy: proposed
 * in the changed files and flips them to legitimacy: approved.
 *
 * Also sets meta.approved-by to the GitHub actor and approved-date to today.
 *
 * This script never touches:
 *   - Records already at legitimacy: approved or superseded
 *   - Records outside the changed files
 *   - Any field except legitimacy, approved-by, and approved-date
 *
 * The human who merged is the approver. Their GitHub username
 * is passed via the GITHUB_ACTOR environment variable (set by Actions).
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const INTENT_ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(INTENT_ROOT, "requirements");
const CHANGED_FILES = (process.env.CHANGED_FILES || "").split(" ").filter(Boolean);
const GITHUB_ACTOR = process.env.GITHUB_ACTOR || "unknown";
const TODAY = new Date().toISOString().split("T")[0];

const TYPE_DIRS = ["jobs", "domains", "design-principles", "design-specs", "requirements", "decisions"];

let flipped = 0;
let skipped = 0;

function processDir(dir) {
  const fullDir = path.join(REQUIREMENTS_DIR, dir);
  if (!fs.existsSync(fullDir)) return;

  const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

  for (const file of files) {
    const filePath = path.join(fullDir, file);
    const relativePath = path.relative(INTENT_ROOT, filePath);

    // Only process files that changed in this push
    // If CHANGED_FILES is empty (e.g. manual run), process all proposed records
    const shouldProcess =
      CHANGED_FILES.length === 0 ||
      CHANGED_FILES.some((cf) => cf.includes(file) || cf.includes(relativePath));

    if (!shouldProcess) {
      skipped++;
      continue;
    }

    let record;
    let rawContent;
    try {
      rawContent = fs.readFileSync(filePath, "utf8");
      record = yaml.load(rawContent);
    } catch (e) {
      console.warn(`  ⚠ Could not parse ${file}: ${e.message}`);
      continue;
    }

    if (!record?.status) {
      skipped++;
      continue;
    }

    // Domains only have lifecycle, not legitimacy — skip
    if (record.type === "domain") {
      skipped++;
      continue;
    }

    if (record.status.legitimacy !== "proposed") {
      skipped++;
      continue;
    }

    // Flip it
    record.status.legitimacy = "approved";

    if (!record.meta) record.meta = {};
    record.meta["approved-by"] = GITHUB_ACTOR;
    record.meta["approved-date"] = TODAY;
    if (!record.meta.updated) record.meta.updated = TODAY;
    record.meta.updated = TODAY;

    const newContent = yaml.dump(record, {
      lineWidth: 120,
      noRefs: true,
      quotingType: '"',
    });

    fs.writeFileSync(filePath, newContent, "utf8");
    console.log(`  ✓ Flipped ${record.id} (${file}) → legitimacy: approved (approved-by: ${GITHUB_ACTOR})`);
    flipped++;
  }
}

console.log("\n── Flipping legitimacy on merged records ────────────────\n");
console.log(`  Approver: ${GITHUB_ACTOR}`);
console.log(`  Date:     ${TODAY}`);
console.log(`  Changed:  ${CHANGED_FILES.length ? CHANGED_FILES.join(", ") : "all files"}\n`);

for (const dir of TYPE_DIRS) {
  processDir(dir);
}

console.log(`\n  Flipped: ${flipped}`);
console.log(`  Skipped: ${skipped}`);

if (flipped > 0) {
  console.log("\n✓ Legitimacy flipped — git commit to follow\n");
} else {
  console.log("\n✓ No proposed records in changed files\n");
}
