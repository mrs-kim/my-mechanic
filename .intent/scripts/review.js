#!/usr/bin/env node
"use strict";

/**
 * review.js
 *
 * Generates a human-readable HTML review page for all proposed records.
 * Opens it in the browser automatically.
 *
 * Usage:
 *   intent review                    — all proposed records
 *   intent review --domain=dom_xyz   — one domain only
 *   intent review --all              — all records including approved
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const { Graph } = require("./agents/lib/graph");

const INTENT_ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(INTENT_ROOT, "requirements");
const OUTPUT_PATH = path.join(INTENT_ROOT, ".intent", "review.html");

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    args[key] = val || true;
  });
  return args;
}

function confidenceBadge(confidence) {
  if (!confidence) return "";
  const colors = { high: "#2da44e", medium: "#bf8700", low: "#cf222e" };
  const color = colors[confidence] || "#656d76";
  return `<span style="background:${color};color:white;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600">${confidence}</span>`;
}

function statusBadge(legitimacy) {
  const colors = { proposed: "#bf8700", approved: "#2da44e", superseded: "#656d76" };
  const color = colors[legitimacy] || "#656d76";
  return `<span style="background:${color};color:white;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600">${legitimacy}</span>`;
}

function escape(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRecord(record, graph) {
  const confidence = record.meta?.["ingestion-confidence"];
  const note = record.meta?.["ingestion-note"];
  const source = record.meta?.["ingestion-source"];
  const legitimacy = record.status?.legitimacy;
  const isLowConfidence = confidence === "low";

  const borderColor = isLowConfidence ? "#cf222e" : legitimacy === "approved" ? "#2da44e" : "#d0d7de";

  let body = "";

  if (record.type === "job") {
    body = `
      <div class="field"><span class="label">Narrative</span><span class="value">${escape(record.narrative)}</span></div>
      <div class="field"><span class="label">Success looks like</span><span class="value">${escape(record["success-looks-like"])}</span></div>
      ${record["out-of-scope"]?.length ? `<div class="field"><span class="label">Out of scope</span><ul class="list">${record["out-of-scope"].map(s => `<li>${escape(s)}</li>`).join("")}</ul></div>` : ""}
    `;
  } else if (record.type === "requirement") {
    const job = record.job ? graph.get(record.job) : null;
    body = `
      <div class="field"><span class="label">Behavior</span><span class="value">${escape(record.behavior)}</span></div>
      ${record.rationale ? `<div class="field"><span class="label">Rationale</span><span class="value">${escape(record.rationale)}</span></div>` : ""}
      ${job ? `<div class="field"><span class="label">Serves job</span><span class="value ref">${escape(job.title)}</span></div>` : ""}
      <div class="field"><span class="label">Implementation</span><span class="value">${record.status?.implementation || "unbuilt"}</span></div>
    `;
  } else if (record.type === "decision") {
    body = `
      <div class="field"><span class="label">Outcome</span><span class="value">${escape(record.outcome)}</span></div>
      <div class="field"><span class="label">Rationale</span><span class="value">${escape(record.rationale)}</span></div>
      <div class="field"><span class="label">Revisit when</span><span class="value">${escape(record["revisit-when"])}</span></div>
    `;
  } else if (record.type === "design-principle") {
    body = `
      <div class="field"><span class="label">Intent</span><span class="value">${escape(record.intent)}</span></div>
      ${record["anti-patterns"]?.length ? `<div class="field"><span class="label">Avoid</span><ul class="list">${record["anti-patterns"].map(s => `<li>${escape(s)}</li>`).join("")}</ul></div>` : ""}
    `;
  }

  return `
    <div class="record" style="border-left:3px solid ${borderColor}" data-id="${record.id}" data-type="${record.type}" data-legitimacy="${legitimacy}">
      <div class="record-header">
        <div class="record-title">
          <span class="record-type">${record.type}</span>
          <span class="record-name">${escape(record.title)}</span>
        </div>
        <div class="record-badges">
          ${confidenceBadge(confidence)}
          ${statusBadge(legitimacy)}
          <span class="record-id">${record.id}</span>
        </div>
      </div>
      ${body}
      ${note ? `<div class="field warn"><span class="label">⚠ Agent note</span><span class="value">${escape(note)}</span></div>` : ""}
      ${source ? `<div class="field"><span class="label">Source</span><span class="value source">${escape(source)}</span></div>` : ""}
    </div>
  `;
}

function renderDomain(domain, records, graph) {
  const byType = {
    job: records.filter(r => r.type === "job"),
    requirement: records.filter(r => r.type === "requirement"),
    decision: records.filter(r => r.type === "decision"),
    "design-principle": records.filter(r => r.type === "design-principle"),
  };

  const total = records.length;
  const lowConf = records.filter(r => r.meta?.["ingestion-confidence"] === "low").length;
  const unresolved = records.filter(r => r.type === "decision" && r.outcome === "unresolved").length;

  let sections = "";
  const typeLabels = {
    job: "Jobs",
    requirement: "Requirements",
    decision: "Decisions",
    "design-principle": "Design Principles",
  };

  for (const [type, typeRecords] of Object.entries(byType)) {
    if (typeRecords.length === 0) continue;
    sections += `
      <div class="type-section">
        <h3 class="type-heading">${typeLabels[type]} <span class="count">${typeRecords.length}</span></h3>
        ${typeRecords.map(r => renderRecord(r, graph)).join("")}
      </div>
    `;
  }

  return `
    <div class="domain" id="${domain.id}">
      <div class="domain-header">
        <div>
          <h2 class="domain-title">${escape(domain.title)}</h2>
          <p class="domain-desc">${escape(domain.description)}</p>
        </div>
        <div class="domain-stats">
          <span class="stat">${total} records</span>
          ${lowConf > 0 ? `<span class="stat warn">⚠ ${lowConf} low confidence</span>` : ""}
          ${unresolved > 0 ? `<span class="stat warn">❓ ${unresolved} unresolved</span>` : ""}
        </div>
      </div>
      ${sections}
    </div>
  `;
}

function generate(graph, args) {
  const domains = graph.all("domain").filter(d => d.status?.lifecycle === "active");
  const showAll = args.all;
  const filterDomain = args.domain;

  let domainSections = "";
  let totalProposed = 0;
  let totalLowConf = 0;

  for (const domain of domains) {
    if (filterDomain && domain.id !== filterDomain) continue;

    let records = graph.byDomain(domain.id).filter(r => r.type !== "domain");

    if (!showAll) {
      records = records.filter(r => r.status?.legitimacy === "proposed");
    }

    if (records.length === 0) continue;

    totalProposed += records.length;
    totalLowConf += records.filter(r => r.meta?.["ingestion-confidence"] === "low").length;

    domainSections += renderDomain(domain, records, graph);
  }

  const title = showAll ? "All Records" : "Proposed Records — Review";
  const subtitle = showAll
    ? `${totalProposed} total records`
    : `${totalProposed} proposed records awaiting review${totalLowConf > 0 ? ` · ${totalLowConf} low confidence` : ""}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intent Harness — ${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; color: #1f2328; background: #f6f8fa; }

    .header { background: #24292f; color: white; padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; }
    .header h1 { font-size: 16px; font-weight: 600; }
    .header .subtitle { font-size: 13px; color: #8b949e; margin-top: 2px; }

    .filter-bar { background: white; border-bottom: 1px solid #d0d7de; padding: 10px 32px; display: flex; gap: 8px; align-items: center; position: sticky; top: 57px; z-index: 99; }
    .filter-btn { padding: 4px 12px; border-radius: 20px; border: 1px solid #d0d7de; background: white; cursor: pointer; font-size: 12px; color: #656d76; }
    .filter-btn.active { background: #0969da; color: white; border-color: #0969da; }
    .filter-label { font-size: 12px; color: #656d76; margin-right: 4px; }

    .nav { width: 220px; position: fixed; top: 100px; left: 0; height: calc(100vh - 100px); overflow-y: auto; padding: 16px; background: white; border-right: 1px solid #d0d7de; }
    .nav-item { display: block; padding: 6px 10px; border-radius: 6px; color: #1f2328; text-decoration: none; font-size: 13px; margin-bottom: 2px; }
    .nav-item:hover { background: #f6f8fa; }
    .nav-item .nav-count { float: right; color: #656d76; font-size: 11px; }

    .main { margin-left: 220px; padding: 24px 32px; max-width: 960px; }

    .domain { background: white; border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 24px; overflow: hidden; }
    .domain-header { padding: 16px 20px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; display: flex; justify-content: space-between; align-items: flex-start; }
    .domain-title { font-size: 18px; font-weight: 600; color: #1f2328; }
    .domain-desc { font-size: 13px; color: #656d76; margin-top: 4px; }
    .domain-stats { text-align: right; }
    .stat { display: inline-block; font-size: 12px; color: #656d76; margin-left: 12px; }
    .stat.warn { color: #cf222e; }

    .type-section { padding: 0 20px 16px; }
    .type-heading { font-size: 13px; font-weight: 600; color: #656d76; text-transform: uppercase; letter-spacing: 0.05em; padding: 16px 0 8px; border-bottom: 1px solid #f0f0f0; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .count { background: #e8f0fe; color: #0969da; border-radius: 10px; padding: 1px 7px; font-size: 11px; font-weight: 600; text-transform: none; letter-spacing: 0; }

    .record { background: #fafafa; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 10px; padding: 14px 16px; }
    .record-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; gap: 12px; }
    .record-title { flex: 1; }
    .record-type { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #656d76; display: block; margin-bottom: 3px; }
    .record-name { font-size: 14px; font-weight: 600; color: #1f2328; line-height: 1.4; }
    .record-badges { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .record-id { font-size: 11px; color: #8b949e; font-family: monospace; }

    .field { display: flex; gap: 12px; margin-bottom: 6px; font-size: 13px; }
    .field.warn { background: #fff8c5; padding: 6px 8px; border-radius: 4px; margin-top: 8px; }
    .label { color: #656d76; min-width: 120px; flex-shrink: 0; font-weight: 500; }
    .value { color: #1f2328; line-height: 1.5; }
    .value.ref { color: #0969da; }
    .value.source { color: #656d76; font-style: italic; font-size: 12px; }
    .list { padding-left: 16px; }
    .list li { margin-bottom: 2px; }

    .empty { text-align: center; padding: 60px; color: #656d76; }
    .empty h2 { font-size: 20px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Intent Harness — ${title}</h1>
      <div class="subtitle">${subtitle} · ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
    </div>
  </div>

  <div class="filter-bar">
    <span class="filter-label">Show:</span>
    <button class="filter-btn active" onclick="filterType('all')">All</button>
    <button class="filter-btn" onclick="filterType('job')">Jobs</button>
    <button class="filter-btn" onclick="filterType('requirement')">Requirements</button>
    <button class="filter-btn" onclick="filterType('decision')">Decisions</button>
    <button class="filter-btn" onclick="filterType('design-principle')">Design Principles</button>
    <button class="filter-btn" onclick="filterType('low-confidence')" style="margin-left:auto;border-color:#cf222e;color:#cf222e">⚠ Low confidence only</button>
  </div>

  <nav class="nav">
    <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#656d76;margin-bottom:8px">Domains</div>
    ${domains
      .filter(d => {
        const records = graph.byDomain(d.id).filter(r => r.type !== "domain" && (!showAll ? r.status?.legitimacy === "proposed" : true));
        return records.length > 0 && (!filterDomain || d.id === filterDomain);
      })
      .map(d => {
        const count = graph.byDomain(d.id).filter(r => r.type !== "domain" && (!showAll ? r.status?.legitimacy === "proposed" : true)).length;
        return `<a class="nav-item" href="#${d.id}">${escape(d.title)}<span class="nav-count">${count}</span></a>`;
      }).join("")}
  </nav>

  <div class="main">
    ${domainSections || `<div class="empty"><h2>No proposed records</h2><p>All records have been reviewed. Run with --all to see approved records.</p></div>`}
  </div>

  <script>
    function filterType(type) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');

      document.querySelectorAll('.record').forEach(r => {
        if (type === 'all') {
          r.style.display = '';
        } else if (type === 'low-confidence') {
          r.style.display = r.dataset.id && r.querySelector('.record-badges span[style*="cf222e"]') ? '' : 'none';
        } else {
          r.style.display = r.dataset.type === type ? '' : 'none';
        }
      });

      document.querySelectorAll('.type-section').forEach(s => {
        const visible = [...s.querySelectorAll('.record')].some(r => r.style.display !== 'none');
        s.style.display = visible ? '' : 'none';
      });

      document.querySelectorAll('.domain').forEach(d => {
        const visible = [...d.querySelectorAll('.record')].some(r => r.style.display !== 'none');
        d.style.display = visible ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = parseArgs();
const graph = new Graph(REQUIREMENTS_DIR);

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
const html = generate(graph, args);
fs.writeFileSync(OUTPUT_PATH, html);

console.log(`\n✓ Review page generated: ${OUTPUT_PATH}`);
console.log(`  Opening in browser...\n`);

try {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execSync(`${opener} "${OUTPUT_PATH}"`);
} catch {
  console.log(`  Could not open automatically. Open this file in your browser:\n  ${OUTPUT_PATH}\n`);
}
