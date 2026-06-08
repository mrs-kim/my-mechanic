"use strict";

/**
 * claude.js
 *
 * Anthropic API wrapper for the spec agent.
 * All prompts are defined here so they can be reviewed, tested,
 * and improved independently of the agent logic.
 *
 * Uses claude-sonnet-4-20250514 for all calls.
 * max_tokens: 2000 — enough for drafting 2-3 records with room for questions.
 */

const https = require("https");

const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.INTENT_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

if (!API_KEY) {
  console.warn("Warning: ANTHROPIC_API_KEY not set — Claude API calls will fail");
}

function callClaude(systemPrompt, userMessage, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
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
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Claude API → ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          const data = JSON.parse(raw);
          const text = data.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          resolve(text);
        } catch (e) {
          reject(new Error(`Claude response parse error: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SPEC_AGENT_SYSTEM = `You are the spec agent for a product requirement harness.

Your job is to help product teams capture product truth — the behavioral decisions that define what a product does and doesn't do.

You draft requirement records, decision records, and design spec records in YAML. You surface clarifying questions when you genuinely need more information. You never make up product decisions — you capture what humans tell you.

## Core rules

AGENTS DRAFT. HUMANS APPROVE.
You propose records. A human merges the PR. Merging is the approval act.
Never present your drafts as final or approved. Always frame them as proposals.

MAX TWO CLARIFYING QUESTIONS.
If you need information to draft well, ask. But ask at most two questions per response, combined into one clear message. If you can make a reasonable inference, do so and state your assumption. Don't ask for information that doesn't change what you'd write.

SMALL RECORDS, RICH GRAPH.
Each requirement should capture one behavioral truth. Complexity belongs in the graph — parent/child relationships, decisions, design principles — not in a single bloated record.
If a request implies multiple behaviors, draft multiple records.

DECISIONS ARE FIRST-CLASS.
When a request implies something the product won't do, draft a decision record for it.
The exclusion is as important as the inclusion. Include a revisit-when field — this is non-negotiable.

NEVER INVENT PRODUCT TRUTH.
If you're uncertain about a behavior, ask. If the human says "I don't know yet," draft the record with a placeholder and mark it clearly.
Do not assume business rules, permission models, or data constraints you weren't told about.

## Output format

When drafting records, present them in this format:

---
**Proposed records for your review**

[Brief 1-2 sentence summary of what you're proposing and why]

**Questions before committing** (if any):
1. [Question]
2. [Question]

---
\`\`\`yaml
# req_xxxxxxxx.yaml
id: req_xxxxxxxx
type: requirement
...
\`\`\`

\`\`\`yaml
# dec_xxxxxxxx.yaml
id: dec_xxxxxxxx
type: decision
...
\`\`\`
---

[Brief note on what you inferred vs what you were told, so the human can correct you]

When you have no questions, omit the questions section.
When corrections come in, acknowledge them briefly and show the updated record.
When the human says "looks good," confirm you'll commit and state the branch name.`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

/**
 * Orientation comment — posted immediately when an issue is opened.
 * Surfaces related existing records. Does NOT draft anything.
 * The team talks first. Drafting happens when someone says @intent-bot draft.
 */
async function orientIssue({ issueTitle, issueBody, relatedRecords, graphSummary, today }) {
  const relatedList = relatedRecords && relatedRecords.length > 0
    ? relatedRecords.map(r =>
        `- [${r.id}] ${r.title}${r.type === "decision" ? ` *(decision: ${r.outcome})*` : ""}`
      ).join("\n")
    : null;

  const user = `A product owner has just opened a GitHub Issue. Your job right now is NOT to draft records.

Your job is to:
1. Briefly acknowledge what they are trying to do — one sentence, conversational, no jargon
2. If relevant records exist, surface them so the team reads them before discussing further
3. Step back and let the humans talk

Do NOT ask clarifying questions. Do NOT draft YAML. Do NOT propose a solution.
The team needs space to discuss constraints, feasibility, design, and scope before anything is captured.
You will draft records when someone explicitly comments "@intent-bot draft".

Today: ${today}

## Existing graph context
${graphSummary || "(no records yet)"}

## Directly related records found
${relatedList || "(none found — this may be net new territory)"}

## Issue title
${issueTitle}

## Issue body
${issueBody}

Write 2 to 5 sentences max. Conversational. End with exactly this sentence:
"When the team is ready to capture this as requirement records, comment \`@intent-bot draft\`."`;

  return callClaude(SPEC_AGENT_SYSTEM, user, 500);
}

/**
 * Draft from full thread — called when someone explicitly triggers @intent-bot draft.
 * Reads the complete issue thread so developer constraints, design input, and scope
 * decisions made during discussion all shape the records — not just the opening post.
 */
async function draftFromIssue({ issueTitle, issueBody, threadContext, graphSummary, today }) {
  const user = `A team has been discussing a GitHub Issue and is now ready to capture it as requirement records.

Read the full conversation carefully. The discussion contains constraints, corrections, and context
that are just as important as the original request. A developer may have flagged feasibility issues.
A designer may have reframed the problem. The scope may have narrowed or expanded. Capture all of it.

Before drafting, evaluate whether the thread gives you enough to write accurate records.
Ask yourself:
- Do I know what triggers this behavior and what the user sees afterward?
- Do I know what the system does when something goes wrong?
- Are there scope boundaries — what this feature explicitly won't do?
- Is the workflow complete, or does it stop halfway through a user's job?

If anything critical is unresolved — especially workflow completion and scope boundaries — ask your
clarifying questions FIRST. Do not draft records until you have the answers. Use at most two questions,
combined into one message.

Only draft immediately if the thread is fully specified and you have clear answers to all of the above.

Today: ${today}

## Existing product graph
${graphSummary || "(no records yet — this is the first requirement)"}

## Issue title
${issueTitle}

## Original issue
${issueBody}

## Full conversation thread (read this carefully — it shapes the records)
${threadContext || "(no additional discussion before draft was requested)"}

Use realistic IDs: req_xxxxxxxx, dec_xxxxxxxx (8 lowercase alphanumeric chars).
Small records — one behavior each. Decisions about exclusions are as important as the requirements.
If the thread reveals a constraint the original issue didn't mention, that constraint belongs in a decision record.`;

  return callClaude(SPEC_AGENT_SYSTEM, user, 2000);
}

/**
 * Processes a correction or additional information from the human.
 * Previous draft is included for context.
 */
async function incorporateCorrection({ previousDraft, correction, today }) {
  const user = `The product owner has reviewed your draft and provided a correction or additional information.

Today's date: ${today}

## Your previous draft
${previousDraft}

## Their response
${correction}

Update the affected records and show the full updated YAML.
If they said "looks good" or equivalent, confirm you'll commit and state that the records are ready to merge.
If they made a correction, show the updated record(s) only — don't repeat unchanged records.`;

  return callClaude(SPEC_AGENT_SYSTEM, user);
}

/**
 * Drafts a design spec record from Figma metadata + PR context.
 */
async function draftDesignSpec({
  figmaUrl,
  figmaMetadata,
  prTitle,
  prBody,
  requirementId,
  requirementTitle,
  designPrincipleId,
  designPrincipleTitle,
  designSystemComponents,
  today,
}) {
  const figmaContext = figmaMetadata
    ? `File: ${figmaMetadata.fileName}
Frame: ${figmaMetadata.frameName || "(no frame name found)"}
Last modified: ${figmaMetadata.lastModified}`
    : "(Figma metadata unavailable — token may be missing)";

  const user = `A designer has dropped a Figma link in a PR comment. Draft a design spec record.

Today's date: ${today}

## Figma link
${figmaUrl}

## Figma metadata
${figmaContext}

## PR context
Title: ${prTitle}
Body excerpt: ${prBody?.slice(0, 500) || "(no body)"}

## Requirement this serves
${requirementId ? `[${requirementId}] ${requirementTitle}` : "(unknown — ask)"}

## Design principle (if applicable)
${designPrincipleId ? `[${designPrincipleId}] ${designPrincipleTitle}` : "(none identified)"}

## Available design system components
${designSystemComponents?.join(", ") || "(design system component list unavailable)"}

Draft the design spec record. Try to match to a design system component.
If no match is found, set design-system-gap: true.
Ask at most two questions about interaction details the Figma frame wouldn't make obvious.`;

  return callClaude(SPEC_AGENT_SYSTEM, user);
}

/**
 * Generates the body for a design-review-needed issue
 * when a requirement is updated after a design spec was approved.
 */
async function draftDesignReviewIssue({
  requirementId,
  requirementTitle,
  requirementChange,
  designSpecId,
  designSpecTitle,
  figmaUrl,
}) {
  const user = `A requirement was updated after a design spec was approved against it.
Draft a clear, actionable GitHub Issue body (not a title — just the body) for the design team.

## Updated requirement
[${requirementId}] ${requirementTitle}

## What changed
${requirementChange}

## Affected design spec
[${designSpecId}] ${designSpecTitle}
Figma: ${figmaUrl}

The issue should:
- Explain what changed in plain language
- Link the requirement and design spec records
- Ask the designer to confirm whether the design needs updating
- Note that this is not a blocker — just a review request
- Be under 200 words`;

  return callClaude(SPEC_AGENT_SYSTEM, user, 500);
}

module.exports = {
  orientIssue,
  draftFromIssue,
  incorporateCorrection,
  draftDesignSpec,
  draftDesignReviewIssue,
};
