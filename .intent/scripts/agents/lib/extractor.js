"use strict";

/**
 * extractor.js
 *
 * Claude calls that extract structured requirement records
 * from unstructured documentation.
 *
 * Three extraction passes:
 *
 *   1. identifyDomains()
 *      Reads all documents and proposes the domain structure.
 *      Human reviews and corrects before extraction begins.
 *
 *   2. extractForDomain()
 *      Given a domain and document chunks, extracts all record
 *      types relevant to that domain.
 *      Returns raw JSON arrays per type.
 *
 *   3. reconcile()
 *      Given extracted records from multiple chunks of the same
 *      domain, merges duplicates and flags contradictions.
 *
 * All calls return structured JSON — the extractor never produces YAML directly.
 * The ingest agent converts to YAML and assigns IDs.
 */

const https = require("https");

const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.INTENT_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

function callClaude(system, user, maxTokens = 4000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
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
          reject(new Error(`Claude API → ${res.statusCode}: ${raw.slice(0, 300)}`));
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

function parseJson(text) {
  // Strip markdown fences if present
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}\n\nRaw response:\n${text.slice(0, 500)}`);
  }
}

// ─── System prompts ───────────────────────────────────────────────────────────

const DOMAIN_SYSTEM = `You are analyzing product documentation to identify the bounded contexts (domains) of a software product.

A domain is a stable named area of the product with clear ownership and boundaries.
Examples: Auth, Onboarding, Billing, Notifications, Search, Dashboard, Content, Reporting.

Rules:
- Identify domains that are clearly present in the documentation
- Don't invent domains that aren't there
- Aim for 3-8 domains — not too granular, not too broad
- Name them simply and clearly
- Each domain needs a one-sentence description of what it owns

Respond ONLY with a JSON array. No preamble. No explanation. No markdown fences.

Format:
[
  {
    "title": "Onboarding",
    "description": "Getting team members through the onboarding process — tracking, admin visibility, reminders.",
    "signals": ["phrases or topics from the docs that indicate this domain"]
  }
]`;

const EXTRACTION_SYSTEM = `You are extracting structured product requirement records from messy documentation.

You are processing documentation for a specific domain of the product.
Extract only content that belongs to this domain — ignore content about other domains.

You will extract four types of records:

JOBS — human needs or business goals this domain serves
  Required: title, narrative (when/need/so-that format), success-looks-like
  
REQUIREMENTS — specific behaviors the system has or should have
  Required: title, behavior (what the system does, testable)
  Optional: rationale (why)
  
DECISIONS — things explicitly ruled out or deferred, or contradictions you found
  Required: title, outcome (excluded/deferred/unresolved), rationale, revisit-when
  Use outcome "unresolved" when the docs contradict themselves
  
DESIGN_PRINCIPLES — experiential intent, how things should feel
  Required: title, intent, anti-patterns (array of strings)

CONFIDENCE levels:
  "high"   — clearly and consistently stated in the docs
  "medium" — implied or stated once without contradiction
  "low"    — inferred, speculative, stated vaguely, or contradicted elsewhere

Rules:
- Extract what the docs actually say — don't invent behaviors
- When docs contradict themselves, extract BOTH as a DECISION with outcome "unresolved"
- Mark anything uncertain as confidence "low" with a note explaining why
- Keep requirements small — one behavior each
- Decisions about what the product DOESN'T do are as important as requirements
- If something appears in docs but you're not sure which type it is, use the type that fits best and mark confidence "low"

Respond ONLY with JSON. No preamble. No markdown fences.

Format:
{
  "jobs": [
    {
      "title": "...",
      "narrative": "When ... I need ... so that ...",
      "success-looks-like": "...",
      "confidence": "high|medium|low",
      "confidence-note": "optional explanation if medium or low",
      "source-hint": "brief quote or reference to where this came from"
    }
  ],
  "requirements": [
    {
      "title": "...",
      "behavior": "...",
      "rationale": "...",
      "confidence": "high|medium|low",
      "confidence-note": "...",
      "source-hint": "..."
    }
  ],
  "decisions": [
    {
      "title": "...",
      "outcome": "excluded|deferred|unresolved",
      "rationale": "...",
      "revisit-when": "...",
      "confidence": "high|medium|low",
      "confidence-note": "...",
      "source-hint": "..."
    }
  ],
  "design_principles": [
    {
      "title": "...",
      "intent": "...",
      "anti-patterns": ["..."],
      "confidence": "high|medium|low",
      "confidence-note": "...",
      "source-hint": "..."
    }
  ]
}`;

const RECONCILE_SYSTEM = `You are reconciling extracted product requirement records from multiple document chunks.

The same document was processed in chunks and each chunk produced extracted records.
Your job is to merge these into a clean, deduplicated set.

Rules:
- Merge records that describe the same behavior (even if worded differently)
- When merging, use the most complete and clear version
- When two records CONTRADICT each other, keep BOTH as a single DECISION record with outcome "unresolved"
  The decision title should describe the contradiction. The rationale should explain both sides.
- Confidence: if any source had "low", merged record is "low". If any had "medium" and none "low", use "medium".
- Remove true duplicates (same behavior, same confidence, nothing added by having both)
- Do not invent new records
- Do not remove records unless they are true duplicates

Respond ONLY with JSON in the same format as the input. No preamble. No markdown fences.`;

// ─── Pass 1: Domain identification ───────────────────────────────────────────

/**
 * Analyzes all documents and proposes the domain structure.
 *
 * @param {string} documentSummary - Combined text from all documents
 * @returns {Promise<Array<{ title, description, signals }>>}
 */
async function identifyDomains(documentSummary) {
  const response = await callClaude(
    DOMAIN_SYSTEM,
    `Analyze this product documentation and identify the domains:\n\n${documentSummary}`,
    1000
  );

  return parseJson(response);
}

// ─── Pass 2: Extraction per domain per chunk ──────────────────────────────────

/**
 * Extracts records for one domain from one document chunk.
 *
 * @param {Object} domain - { title, description }
 * @param {string} chunk - Document text chunk
 * @param {string} existingGraphSummary - Summary of already-approved records
 * @returns {Promise<Object>} - { jobs, requirements, decisions, design_principles }
 */
async function extractForDomain(domain, chunk, existingGraphSummary = "") {
  const context = [
    `## Domain being extracted`,
    `Name: ${domain.title}`,
    `Description: ${domain.description}`,
    existingGraphSummary
      ? `\n## Already approved requirements in this domain (do not re-extract these)\n${existingGraphSummary}`
      : "",
    `\n## Document chunk to extract from`,
    chunk,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await callClaude(EXTRACTION_SYSTEM, context, 4000);

  try {
    return parseJson(response);
  } catch (e) {
    // Return empty extraction rather than crashing the whole run
    console.warn(`    ⚠ Extraction parse failed for chunk: ${e.message.slice(0, 100)}`);
    return { jobs: [], requirements: [], decisions: [], design_principles: [] };
  }
}

// ─── Pass 3: Reconciliation ───────────────────────────────────────────────────

/**
 * Merges extracted records from multiple chunks into a clean set.
 * Deduplicates and flags contradictions.
 *
 * @param {Object[]} extractions - Array of extraction results from each chunk
 * @returns {Promise<Object>} - Merged { jobs, requirements, decisions, design_principles }
 */
async function reconcile(extractions) {
  // If only one chunk, no reconciliation needed
  if (extractions.length === 1) return extractions[0];

  // Merge all extractions into one JSON blob for Claude to reconcile
  const merged = {
    jobs: extractions.flatMap((e) => e.jobs || []),
    requirements: extractions.flatMap((e) => e.requirements || []),
    decisions: extractions.flatMap((e) => e.decisions || []),
    design_principles: extractions.flatMap((e) => e.design_principles || []),
  };

  // If total records is small, reconcile in one pass
  const totalRecords =
    merged.jobs.length +
    merged.requirements.length +
    merged.decisions.length +
    merged.design_principles.length;

  if (totalRecords === 0) return merged;

  // Don't call Claude if nothing to reconcile
  if (totalRecords <= 5) return merged;

  const response = await callClaude(
    RECONCILE_SYSTEM,
    `Reconcile these extracted records:\n\n${JSON.stringify(merged, null, 2)}`,
    4000
  );

  try {
    return parseJson(response);
  } catch (e) {
    console.warn(`    ⚠ Reconciliation parse failed: ${e.message.slice(0, 100)}`);
    return merged; // Fall back to unreconciled
  }
}

// ─── Summary generation ───────────────────────────────────────────────────────

/**
 * Generates a human-readable summary of what was extracted,
 * for the PR description and the final report.
 */
async function summarizeExtraction(domainTitle, records) {
  const counts = {
    jobs: (records.jobs || []).length,
    requirements: (records.requirements || []).length,
    decisions: (records.decisions || []).length,
    principles: (records.design_principles || []).length,
  };

  const lowConfidence = [
    ...(records.jobs || []).filter((r) => r.confidence === "low"),
    ...(records.requirements || []).filter((r) => r.confidence === "low"),
    ...(records.decisions || []).filter((r) => r.confidence === "low"),
    ...(records.design_principles || []).filter((r) => r.confidence === "low"),
  ];

  const unresolved = (records.decisions || []).filter(
    (d) => d.outcome === "unresolved"
  );

  return {
    domain: domainTitle,
    counts,
    lowConfidence: lowConfidence.map((r) => ({
      title: r.title,
      note: r["confidence-note"],
    })),
    unresolved: unresolved.map((r) => ({
      title: r.title,
      rationale: r.rationale,
    })),
  };
}

module.exports = {
  identifyDomains,
  extractForDomain,
  reconcile,
  summarizeExtraction,
};
