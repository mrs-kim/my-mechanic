#!/usr/bin/env node
"use strict";

/**
 * test-agent.js
 *
 * Generates acceptance-criteria YAML blocks for approved requirements
 * that don't yet have them. Runs on post-merge and on demand.
 *
 * The test agent does not run tests itself. It generates the
 * given/when/then criteria that humans and CI use as the specification
 * for what tests must prove.
 *
 * Human review of generated criteria is expected before they become
 * canonical — the agent writes them as proposed additions to the
 * requirement record. A human reviews the PR and merges.
 *
 * Usage:
 *   node test-agent.js --mode=all         Generate criteria for all uncovered reqs
 *   node test-agent.js --mode=single --req=req_cv3p8x   Single requirement
 *   node test-agent.js --mode=pr          Only reqs changed in current PR
 *
 * Environment:
 *   INTENT_ROOT        path to repo root
 *   ANTHROPIC_API_KEY   Claude API key
 *   GITHUB_TOKEN        for opening PRs with generated criteria
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
const TODAY = new Date().toISOString().split("T")[0];
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.INTENT_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    args[key] = val || true;
  });
  return args;
}

// ─── Claude call ──────────────────────────────────────────────────────────────

const https = require("https");

function callClaude(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Claude API → ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          const data = JSON.parse(raw);
          resolve(data.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── System prompt ────────────────────────────────────────────────────────────

const TEST_AGENT_SYSTEM = `You are the test agent for a product requirement harness.

Your job is to generate acceptance criteria for product requirements in given/when/then format.

## Rules

CRITERIA MUST BE DIRECTLY TESTABLE.
Each criterion must be specific enough that an engineer can write a test for it without asking any questions.
Vague criteria like "the system works correctly" are useless. Be concrete.

COVER THE HAPPY PATH AND THE EDGES.
Every requirement has a primary success case. Most also have edge cases.
Generate criteria for both. Typical edge cases: empty state, large data sets, permission boundaries,
error conditions implied by the behavior, concurrent users.

DO NOT INVENT BUSINESS RULES.
If the requirement doesn't say what happens in a situation, don't assume.
Only generate criteria for behaviors the requirement explicitly describes or clearly implies.

DON'T REPEAT THE REQUIREMENT.
The given/when/then should add precision, not paraphrase.
"Given: the user is on the dashboard" is better than "Given: the system is in the dashboard state".

FORMAT.
Respond ONLY with a YAML array. No preamble, no explanation, no markdown fences.
Each item has exactly three fields: given, when, then.
All three fields are strings, present tense, specific.

Example output:
- given: an admin is authenticated and viewing a team with 5 members
  when: they click the Export CSV button
  then: a file named team-onboarding-{date}.csv downloads with 5 rows plus a header row

- given: the team has 0 members
  when: the admin clicks Export CSV
  then: a CSV downloads containing only the header row, no member rows

- given: a non-admin user is viewing the dashboard
  when: they inspect the page
  then: the Export CSV button is not present in the DOM`;

// ─── Generate criteria for one requirement ────────────────────────────────────

async function generateCriteria(record, graph) {
  const job = record.job ? graph.get(record.job) : null;
  const domain = record.domain ? graph.get(record.domain) : null;
  const decisions = graph.decisionsFor(record.id);
  const parent = record.relationships?.parent ? graph.get(record.relationships.parent) : null;

  const context = [
    `## Requirement`,
    `ID: ${record.id}`,
    `Title: ${record.title}`,
    ``,
    `## Behavior`,
    record.behavior,
    job ? `\n## Job this serves\n${job.title}: ${job.narrative}` : "",
    parent ? `\n## Parent requirement\n${parent.title}: ${parent.behavior}` : "",
    decisions.length > 0
      ? `\n## Relevant decisions (scope constraints)\n${decisions.map((d) => `- ${d.title}: ${d.rationale}`).join("\n")}`
      : "",
    domain ? `\n## Domain\n${domain.title}: ${domain.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await callClaude(TEST_AGENT_SYSTEM, context);

  // Parse the YAML response
  try {
    const criteria = yaml.load(response.trim());
    if (!Array.isArray(criteria)) {
      throw new Error("Response was not a YAML array");
    }
    // Validate each criterion has the required fields
    for (const c of criteria) {
      if (!c.given || !c.when || !c.then) {
        throw new Error(`Criterion missing given/when/then: ${JSON.stringify(c)}`);
      }
    }
    return criteria;
  } catch (e) {
    throw new Error(`Could not parse acceptance criteria from Claude response: ${e.message}\n\nResponse was:\n${response}`);
  }
}

// ─── Write criteria back to record ───────────────────────────────────────────

function writeAcceptanceCriteria(record, criteria, filePath) {
  record["acceptance-criteria"] = criteria;
  if (!record.meta) record.meta = {};
  record.meta.updated = TODAY;

  const content = yaml.dump(record, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
  });

  fs.writeFileSync(filePath, content, "utf8");
}

// ─── Find requirements needing criteria ──────────────────────────────────────

function findUncovered(graph) {
  return graph.all("requirement").filter((r) => {
    if (r.status?.legitimacy !== "approved") return false;
    if (r.status?.lifecycle !== "active") return false;
    const criteria = r["acceptance-criteria"] || [];
    return criteria.length === 0;
  });
}

// ─── Commit generated criteria as a PR ───────────────────────────────────────

async function commitCriteriaAsPR(updatedFiles, reqIds) {
  const branchName = `harness/test-agent-${TODAY.replace(/-/g, "")}`;
  const defaultBranch = await github.getDefaultBranch();

  try {
    const ref = await github.getRef(defaultBranch);
    await github.createBranch(branchName, ref.object.sha);
  } catch (e) {
    if (!e.message.includes("422")) throw e;
  }

  await github.commitFiles(
    updatedFiles,
    `feat: add acceptance criteria for ${reqIds.length} requirement(s) [test-agent]`,
    branchName
  );

  const reqList = reqIds.map((id) => `- \`${id}\``).join("\n");

  const pr = await github.createPR(
    `feat: acceptance criteria for ${reqIds.length} requirement(s)`,
    `## Acceptance criteria generated by test agent

The test agent generated \`acceptance-criteria\` blocks for requirements that didn't have them.

**Requirements covered:**
${reqList}

## Review instructions

Read each criterion and verify:
- [ ] It's specific enough to write a test for
- [ ] It covers the happy path
- [ ] Edge cases match the actual behavior (not invented assumptions)
- [ ] Nothing was generated that contradicts an active decision record

Merge to add these criteria to the requirement records.
You are the accountable human — these become canonical only when you merge.

## Requirement records
${reqIds.join(", ")}

## Design review
- [ ] No — acceptance criteria changes don't require design review`,
    branchName
  );

  return pr;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const mode = args.mode || "all";

  if (!API_KEY) {
    console.error("ANTHROPIC_API_KEY (or INTENT_API_KEY) is required");
    process.exit(1);
  }

  const graph = new Graph(REQUIREMENTS_DIR);
  console.log(`\n── Test agent (${mode} mode) ──────────────────────────────\n`);

  let targets = [];

  if (mode === "single") {
    if (!args.req) {
      console.error("--req=<id> is required for single mode");
      process.exit(1);
    }
    const record = graph.get(args.req);
    if (!record) {
      console.error(`Record not found: ${args.req}`);
      process.exit(1);
    }
    targets = [record];
  } else if (mode === "all" || mode === "pr") {
    targets = findUncovered(graph);
    console.log(`  Found ${targets.length} approved+active requirements without acceptance criteria`);
  }

  if (targets.length === 0) {
    console.log("  ✓ All approved+active requirements have acceptance criteria\n");
    process.exit(0);
  }

  const updatedFiles = [];
  const succeededIds = [];
  const failedIds = [];

  for (const record of targets) {
    process.stdout.write(`  Generating criteria for ${record.id} (${record.title.slice(0, 50)})... `);

    try {
      const criteria = await generateCriteria(record, graph);

      const filePath = path.join(
        REQUIREMENTS_DIR,
        "requirements",
        `${record.id}.yaml`
      );

      if (!fs.existsSync(filePath)) {
        console.log(`skipped (file not found at ${filePath})`);
        failedIds.push(record.id);
        continue;
      }

      // Write locally for inspection
      writeAcceptanceCriteria(record, criteria, filePath);

      // Queue for PR commit
      updatedFiles.push({
        path: `requirements/requirements/${record.id}.yaml`,
        content: fs.readFileSync(filePath, "utf8"),
      });

      console.log(`✓ ${criteria.length} criteria`);
      succeededIds.push(record.id);

      // Brief pause to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      console.log(`✗ ${e.message.split("\n")[0]}`);
      failedIds.push(record.id);
    }
  }

  console.log(`\n  Generated: ${succeededIds.length}`);
  if (failedIds.length > 0) {
    console.log(`  Failed:    ${failedIds.length} (${failedIds.join(", ")})`);
  }

  // In single mode, just print the result
  if (mode === "single") {
    const record = graph.get(args.req);
    const updated = yaml.load(
      fs.readFileSync(
        path.join(REQUIREMENTS_DIR, "requirements", `${args.req}.yaml`),
        "utf8"
      )
    );
    console.log("\n── Generated criteria ──────────────────────────────────\n");
    updated["acceptance-criteria"]?.forEach((c, i) => {
      console.log(`  ${i + 1}. Given ${c.given}`);
      console.log(`     When  ${c.when}`);
      console.log(`     Then  ${c.then}\n`);
    });
    console.log("✓ Written to record. Review and commit manually.\n");
    process.exit(0);
  }

  // Open a PR with all generated criteria
  if (succeededIds.length > 0 && process.env.GITHUB_TOKEN) {
    try {
      const pr = await commitCriteriaAsPR(updatedFiles, succeededIds);
      console.log(`\n  ✓ PR opened: ${pr.html_url}`);
      console.log("  Review the criteria and merge to make them canonical.\n");
    } catch (e) {
      console.warn(`\n  Could not open PR: ${e.message}`);
      console.log("  Criteria written locally — commit and push manually.\n");
    }
  } else if (succeededIds.length > 0) {
    console.log("\n  Criteria written locally (no GITHUB_TOKEN — commit manually).\n");
  }

  process.exit(failedIds.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`Test agent error: ${e.message}`);
  process.exit(1);
});
