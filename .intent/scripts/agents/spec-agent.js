#!/usr/bin/env node
"use strict";

/**
 * spec-agent.js
 *
 * The spec agent orchestrator.
 * Called by GitHub Actions workflows with an event type and context.
 *
 * Usage:
 *   node spec-agent.js --event=issue_opened --issue=42
 *   node spec-agent.js --event=issue_comment --issue=42 --comment=123
 *   node spec-agent.js --event=pr_comment --pr=17 --comment=456
 *   node spec-agent.js --event=requirement_updated --req=req_cv3p8x --pr=17
 *
 * Environment:
 *   GITHUB_TOKEN          — provided by Actions
 *   ANTHROPIC_API_KEY     — from repo secrets (INTENT_API_KEY)
 *   FIGMA_ACCESS_TOKEN    — from repo secrets (optional)
 *   GITHUB_REPOSITORY     — owner/repo, provided by Actions
 *   INTENT_ROOT          — path to repo root (defaults to cwd)
 */

const path = require("path");
const fs = require("fs");
const yaml = require("js-yaml");

const { Graph } = require("./lib/graph");
const github = require("./lib/github");
const claude = require("./lib/claude");
const { fetchFigmaMetadata, extractFigmaUrls } = require("./lib/figma");
const { generateId } = require("./lib/ids");

const INTENT_ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(INTENT_ROOT, "requirements");
const TODAY = new Date().toISOString().split("T")[0];

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    args[key] = val;
  });
  return args;
}

// ─── State helpers ────────────────────────────────────────────────────────────

/**
 * The spec agent needs to track conversation state across GitHub comments.
 * We store state as a JSON block inside a hidden HTML comment in the
 * agent's own issue comment. This is git-native, requires no external storage,
 * and is fully auditable.
 *
 * Format:
 *   <!-- harness-agent-state
 *   { "phase": "awaiting_correction", "draft": "...", "recordIds": [...] }
 *   -->
 */

const STATE_MARKER = "<!-- harness-agent-state";

function encodeState(state) {
  return `${STATE_MARKER}\n${JSON.stringify(state, null, 2)}\n-->`;
}

function decodeState(commentBody) {
  const start = commentBody.indexOf(STATE_MARKER);
  if (start === -1) return null;
  const end = commentBody.indexOf("-->", start);
  if (end === -1) return null;
  try {
    const json = commentBody.slice(start + STATE_MARKER.length, end).trim();
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Finds the most recent spec agent comment on an issue.
 * Returns { comment, state } or null.
 */
async function findAgentState(issueNumber) {
  const comments = await github.getIssueComments(issueNumber);
  // Agent comments are identified by the state marker
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.body?.includes(STATE_MARKER)) {
      const state = decodeState(comment.body);
      return { comment, state };
    }
  }
  return null;
}

// ─── YAML serialization ───────────────────────────────────────────────────────

/**
 * Extracts YAML blocks from Claude's response text.
 * Returns array of { filename, content } objects.
 */
function extractYamlBlocks(text) {
  const blocks = [];
  const pattern = /```yaml\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const content = match[1];
    // Try to parse to get the id and type
    try {
      const parsed = yaml.load(content);
      if (parsed?.id && parsed?.type) {
        const typeDirs = {
          job: "jobs",
          domain: "domains",
          "design-principle": "design-principles",
          "design-spec": "design-specs",
          requirement: "requirements",
          decision: "decisions",
        };
        const dir = typeDirs[parsed.type];
        if (dir) {
          blocks.push({
            filename: `requirements/${dir}/${parsed.id}.yaml`,
            id: parsed.id,
            type: parsed.type,
            content,
          });
        }
      }
    } catch {
      // skip malformed blocks
    }
  }
  return blocks;
}

/**
 * Removes the hidden state comment from agent response text
 * so humans only see the readable content.
 */
function stripStateFromComment(text) {
  const start = text.indexOf(STATE_MARKER);
  if (start === -1) return text;
  const end = text.indexOf("-->", start);
  return (text.slice(0, start) + text.slice(end + 3)).trim();
}

// ─── Branch helpers ───────────────────────────────────────────────────────────

async function createAgentBranch(issueNumber) {
  const branchName = `harness/issue-${issueNumber}-spec`;
  const defaultBranch = await github.getDefaultBranch();

  try {
    const ref = await github.getRef(defaultBranch);
    await github.createBranch(branchName, ref.object.sha);
  } catch (e) {
    // Branch may already exist — that's fine
    if (!e.message.includes("422")) throw e;
  }

  return branchName;
}

// ─── Detect human intent in a comment ────────────────────────────────────────

function isApproval(text) {
  const t = text.toLowerCase().trim();
  return (
    t.includes("looks good") ||
    t === "lgtm" ||
    t.includes("approve") ||
    t.includes("ship it") ||
    t === "✓" ||
    t === "👍"
  );
}

function isDraftRequest(text) {
  return /@intent-bot\s+draft/i.test(text);
}

function isFigmaLink(text) {
  return extractFigmaUrls(text).length > 0;
}

/**
 * Formats the full issue thread as readable context for Claude.
 * Excludes agent comments (they contain the state marker) to avoid
 * feeding Claude its own previous outputs as if they were human input.
 */
function formatThreadContext(comments, openingBody) {
  const humanComments = comments.filter(c => !c.body?.includes(STATE_MARKER));
  if (humanComments.length === 0) return null;

  return humanComments.map(c => {
    const author = c.user?.login || "unknown";
    const body = c.body?.trim() || "";
    return `**${author}:** ${body}`;
  }).join("\n\n");
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * Handle: explicit "@intent-bot draft" comment
 *
 * Reads the full issue thread — opening post plus all human comments —
 * and drafts requirement records that reflect the complete conversation.
 * Developer constraints, designer input, scope decisions all shape the records.
 */
async function handleDraftRequest(issueNumber, comments) {
  const issue = await github.getIssue(issueNumber);
  const graph = new Graph(REQUIREMENTS_DIR);

  const inferredDomain = graph.inferDomain(`${issue.title} ${issue.body || ""}`);
  const graphSummary = graph.summarize(inferredDomain?.id);

  // Build thread context from all human comments, excluding agent comments
  const threadContext = formatThreadContext(comments, issue.body);

  console.log(`  Thread context: ${threadContext ? threadContext.length + " chars from " + comments.filter(c => !c.body?.includes(STATE_MARKER)).length + " human comment(s)" : "none"}`);

  const response = await claude.draftFromIssue({
    issueTitle: issue.title,
    issueBody: issue.body || "",
    threadContext,
    graphSummary,
    today: TODAY,
  });

  const yamlBlocks = extractYamlBlocks(response);
  const recordIds = yamlBlocks.map((b) => b.id);

  const state = encodeState({
    phase: "awaiting_correction",
    issueNumber,
    draft: response,
    recordIds,
    yamlBlocks: yamlBlocks.map((b) => ({
      filename: b.filename,
      content: b.content,
    })),
  });

  const commentBody = `${response}

---
*Reply with corrections or "looks good" to commit these records to a branch and open a PR.*

${state}`;
  await github.createIssueComment(issueNumber, commentBody);
  console.log(`Posted draft to issue #${issueNumber}`);
}


/**
 * Handle: new issue opened
 *
 * Posts a lightweight orientation comment that surfaces related
 * existing records and invites human discussion.
 *
 * Does NOT draft records immediately. The team discusses first.
 * Drafting happens when someone explicitly comments "@intent-bot draft".
 */
async function handleIssueOpened(issueNumber) {
  console.log(`Handling issue_opened for #${issueNumber}`);

  const issue = await github.getIssue(issueNumber);
  const graph = new Graph(REQUIREMENTS_DIR);

  const inferredDomain = graph.inferDomain(`${issue.title} ${issue.body || ""}`);
  const graphSummary = graph.summarize(inferredDomain?.id);

  // Find related records to surface in the orientation comment
  const relatedReqs = graph.findRelated(`${issue.title} ${issue.body || ""}`, inferredDomain?.id);
  const relatedDecisions = graph.all("decision").filter(d =>
    d.status?.legitimacy === "approved" &&
    d.status?.lifecycle === "active" &&
    d.domain === inferredDomain?.id
  );

  // Surface top 3 requirements and all active decisions for the inferred domain
  const relatedRecords = [
    ...relatedReqs.slice(0, 3),
    ...relatedDecisions.slice(0, 3),
  ];

  const response = await claude.orientIssue({
    issueTitle: issue.title,
    issueBody: issue.body || "",
    relatedRecords,
    graphSummary,
    today: TODAY,
  });

  // Store minimal state so we know the issue has been oriented
  const state = encodeState({
    phase: "awaiting_draft_request",
    issueNumber,
  });

  const commentBody = `${response}\n\n${state}`;
  await github.createIssueComment(issueNumber, commentBody);
  console.log(`Posted orientation comment to issue #${issueNumber}`);
}

/**
 * Handle: comment on an issue
 *
 * Four cases:
 * A. "@intent-bot draft" → read full thread, draft records
 * B. Human says "looks good" after a draft → commit records, open PR
 * C. Human provides correction to a draft → update draft, re-post
 * D. Figma URL → hand off to design spec handler
 */
async function handleIssueComment(issueNumber, commentId) {
  console.log(`Handling issue_comment on #${issueNumber}, comment ${commentId}`);

  const comments = await github.getIssueComments(issueNumber);
  const triggerComment = comments.find((c) => c.id === parseInt(commentId));

  if (!triggerComment) {
    console.log("Trigger comment not found — skipping");
    return;
  }

  // Don't respond to our own comments
  if (triggerComment.body?.includes(STATE_MARKER)) {
    console.log("Comment is from agent — skipping");
    return;
  }

  const humanText = triggerComment.body || "";
  const agentState = await findAgentState(issueNumber);
  const { state } = agentState || { state: null };

  // Case A: explicit draft request — read full thread and draft
  if (isDraftRequest(humanText)) {
    console.log("Draft request received — reading full thread");
    await handleDraftRequest(issueNumber, comments);
    return;
  }

  // Without a prior draft, we can't handle B or C
  if (!state || state.phase === "awaiting_draft_request") {
    console.log("No draft in progress — ignoring non-draft comment");
    return;
  }

  // Case B: approval
  if (isApproval(humanText)) {
    await commitAndOpenPR(issueNumber, state);
    return;
  }

  // Case C: correction or additional info
  const response = await claude.incorporateCorrection({
    previousDraft: state.draft,
    correction: humanText,
    today: TODAY,
  });

  const yamlBlocks = extractYamlBlocks(response);

  // Merge updated blocks with previous ones
  const updatedBlocks = [...(state.yamlBlocks || [])];
  for (const block of yamlBlocks) {
    const existing = updatedBlocks.findIndex((b) => b.filename === block.filename);
    if (existing >= 0) {
      updatedBlocks[existing] = { filename: block.filename, content: block.content };
    } else {
      updatedBlocks.push({ filename: block.filename, content: block.content });
    }
  }

  const newState = encodeState({
    phase: "awaiting_correction",
    issueNumber,
    draft: response,
    recordIds: updatedBlocks.map((b) => {
      try {
        return yaml.load(b.content)?.id;
      } catch {
        return null;
      }
    }).filter(Boolean),
    yamlBlocks: updatedBlocks,
  });

  const commentBody = `${response}\n\n---\n*Reply with further corrections or "looks good" to commit.*\n\n${newState}`;
  await github.createIssueComment(issueNumber, commentBody);
}

/**
 * Commits approved YAML records to a branch and opens a PR.
 */
async function commitAndOpenPR(issueNumber, state) {
  console.log(`Committing records for issue #${issueNumber}`);

  const issue = await github.getIssue(issueNumber);
  const branchName = await createAgentBranch(issueNumber);

  const files = (state.yamlBlocks || []).map((b) => ({
    path: b.filename,
    content: b.content,
  }));

  if (files.length === 0) {
    await github.createIssueComment(
      issueNumber,
      "I couldn't find any valid YAML records to commit. Could you clarify what records you'd like created?"
    );
    return;
  }

  await github.commitFiles(
    files,
    `feat: add proposed requirement records for #${issueNumber} [intent-bot]`,
    branchName
  );

  const recordList = (state.recordIds || []).map((id) => `- \`${id}\``).join("\n");

  const prBody = `## Proposed requirement records

${recordList}

Drafted by the spec agent from issue #${issueNumber}: ${issue.title}

## Requirement records
${(state.recordIds || []).map((id) => `- ${id}`).join("\n")}

## Design review
- [ ] No — no UI changes (update if design is involved)

## Human accountability checklist
- [ ] Every behavior change has a corresponding requirement record
- [ ] Every new requirement traces to a job
- [ ] Decisions about exclusions are recorded as decision records
- [ ] If an existing approved requirement was modified, the change is intentional

---
*These records are \`legitimacy: proposed\`. Merging this PR approves them as canonical product truth.*
*Review the YAML carefully before merging — you are the accountable human.*`;

  const pr = await github.createPR(
    `feat: requirement records for "${issue.title}"`,
    prBody,
    branchName
  );

  await github.createIssueComment(
    issueNumber,
    `Records committed to branch \`${branchName}\` and PR opened: ${pr.html_url}\n\nReview the YAML, then merge to approve these as canonical product truth. You are the accountable human — merging is your approval.`
  );

  console.log(`PR opened: ${pr.html_url}`);
}

/**
 * Handle: Figma URL dropped in a PR comment
 */
async function handlePRComment(prNumber, commentId) {
  console.log(`Handling pr_comment on PR #${prNumber}, comment ${commentId}`);

  const comments = await github.getPRComments(prNumber);
  const triggerComment = comments.find((c) => c.id === parseInt(commentId));

  if (!triggerComment) return;
  if (triggerComment.body?.includes(STATE_MARKER)) return;

  const figmaUrls = extractFigmaUrls(triggerComment.body || "");
  if (figmaUrls.length === 0) return;

  const pr = await github.getPR(prNumber);
  const graph = new Graph(REQUIREMENTS_DIR);

  // Find the requirement this PR is for from PR body
  const reqMatch = (pr.body || "").match(/req_[a-z0-9]{6,12}/g);
  const requirementId = reqMatch?.[0];
  const requirement = requirementId ? graph.get(requirementId) : null;

  // Find relevant design principle
  let designPrincipleId = null;
  let designPrincipleTitle = null;
  if (requirement?.domain) {
    const principles = graph
      .all("design-principle")
      .filter(
        (dp) =>
          dp.domain === requirement.domain &&
          dp.status?.legitimacy === "approved"
      );
    if (principles[0]) {
      designPrincipleId = principles[0].id;
      designPrincipleTitle = principles[0].title;
    }
  }

  // Process each Figma URL (usually just one)
  for (const url of figmaUrls) {
    const figmaMetadata = await fetchFigmaMetadata(url);

    const response = await claude.draftDesignSpec({
      figmaUrl: url,
      figmaMetadata,
      prTitle: pr.title,
      prBody: pr.body,
      requirementId,
      requirementTitle: requirement?.title,
      designPrincipleId,
      designPrincipleTitle,
      designSystemComponents: [], // TODO: load from design system repo
      today: TODAY,
    });

    const yamlBlocks = extractYamlBlocks(response);

    const state = encodeState({
      phase: "awaiting_design_correction",
      prNumber,
      figmaUrl: url,
      requirementId,
      draft: response,
      yamlBlocks: yamlBlocks.map((b) => ({
        filename: b.filename,
        content: b.content,
      })),
    });

    const commentBody = `${response}\n\n---\n*Reply "looks good" to commit this design spec to the PR branch, or correct any details.*\n\n${state}`;

    await github.createIssueComment(prNumber, commentBody);
  }
}

/**
 * Handle: a requirement was updated — check if any design specs need review
 */
async function handleRequirementUpdated(requirementId, prNumber) {
  console.log(`Handling requirement_updated for ${requirementId}`);

  const graph = new Graph(REQUIREMENTS_DIR);
  const requirement = graph.get(requirementId);
  if (!requirement) return;

  const designSpecs = graph.designSpecsForRequirement(requirementId);
  const approvedSpecs = designSpecs.filter(
    (ds) =>
      ds.status?.legitimacy === "approved" && ds.status?.lifecycle === "active"
  );

  if (approvedSpecs.length === 0) return;

  const pr = prNumber ? await github.getPR(prNumber) : null;
  const changeDescription = pr
    ? `PR #${prNumber}: ${pr.title}`
    : "requirement updated";

  for (const spec of approvedSpecs) {
    const issueBody = await claude.draftDesignReviewIssue({
      requirementId,
      requirementTitle: requirement.title,
      requirementChange: changeDescription,
      designSpecId: spec.id,
      designSpecTitle: spec.title,
      figmaUrl: spec.figma,
    });

    await github.createIssue(
      `Design review needed: ${spec.title}`,
      issueBody,
      ["design-review-needed"]
    );

    console.log(`Opened design review issue for ${spec.id}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const event = args.event;

  if (!event) {
    console.error("--event is required");
    process.exit(1);
  }

  try {
    switch (event) {
      case "issue_opened":
        await handleIssueOpened(parseInt(args.issue));
        break;

      case "issue_comment":
        await handleIssueComment(parseInt(args.issue), args.comment);
        break;

      case "pr_comment":
        await handlePRComment(parseInt(args.pr), args.comment);
        break;

      case "requirement_updated":
        await handleRequirementUpdated(args.req, args.pr ? parseInt(args.pr) : null);
        break;

      default:
        console.error(`Unknown event: ${event}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`Spec agent error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
