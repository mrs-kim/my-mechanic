#!/usr/bin/env node
"use strict";

/**
 * review.js
 *
 * Runs a local server for reviewing, editing, and approving requirement records.
 * Opens the browser automatically. Ctrl+C to stop.
 *
 * Usage:
 *   intent review                    — proposed records only
 *   intent review --all              — all records including approved
 *   intent review --domain=dom_xyz   — one domain only
 *   intent review --port=3333        — custom port (default 3131)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync, spawn } = require("child_process");
const yaml = require("js-yaml");
const { Graph } = require("./agents/lib/graph");

const INTENT_ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(INTENT_ROOT, "requirements");

// Load .env from project root if present
const dotenvPath = path.join(INTENT_ROOT, ".env");
if (fs.existsSync(dotenvPath)) {
  fs.readFileSync(dotenvPath, "utf8").split("\n").forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  });
}

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    args[key] = val || true;
  });
  return args;
}

function escape(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Record rendering ─────────────────────────────────────────────────────────

function editableField(label, fieldKey, value, recordId, multiline = false) {
  const val = value || "";
  const tag = multiline ? "textarea" : "input";
  const extra = multiline ? 'rows="3"' : 'type="text"';
  return `
    <div class="field">
      <span class="label">${label}</span>
      <div class="field-edit">
        <${tag} class="field-input" data-field="${fieldKey}" data-id="${recordId}" ${extra}>${multiline ? escape(val) : ""}</${tag}>
        ${!multiline ? `<input type="text" class="field-input" data-field="${fieldKey}" data-id="${recordId}" value="${escape(val)}">` : ""}
      </div>
    </div>`;
}

function renderField(label, value, fieldKey, recordId, multiline = false) {
  const val = value || "";
  const inputAttr = multiline
    ? `<textarea class="field-input" data-field="${fieldKey}" data-id="${recordId}" rows="3">${escape(val)}</textarea>`
    : `<input type="text" class="field-input" data-field="${fieldKey}" data-id="${recordId}" value="${escape(val)}">`;
  return `
    <div class="field">
      <span class="label">${label}</span>
      <div class="field-edit-wrap">
        <span class="field-value">${escape(val)}</span>
        ${inputAttr}
      </div>
    </div>`;
}

function renderDomainField(record, graph) {
  const currentId = record.domain || "";
  const currentDomain = currentId ? graph.get(currentId) : null;
  const currentTitle = currentDomain ? currentDomain.title : (currentId || "—");
  const domains = graph.all("domain").filter(d => d.status?.lifecycle === "active");
  const options = domains.map(d =>
    `<option value="${d.id}"${d.id === currentId ? " selected" : ""}>${escape(d.title)}</option>`
  ).join("");
  return `
    <div class="field">
      <span class="label">Domain</span>
      <div class="field-edit-wrap">
        <span class="field-value">${escape(currentTitle)}</span>
        <select class="field-input domain-select" data-field="domain" data-id="${record.id}">
          ${options}
          <option value="__new__">+ New domain…</option>
        </select>
      </div>
    </div>`;
}

function renderRecord(record, filePath, graph) {
  const confidence = record.meta?.["ingestion-confidence"];
  const note = record.meta?.["ingestion-note"];
  const source = record.meta?.["ingestion-source"];
  const legitimacy = record.status?.legitimacy;
  const implementation = record.status?.implementation;
  const domain = record.domain;

  const borderColor = legitimacy === "approved" ? "#2da44e" : confidence === "low" ? "#cf222e" : "#d0d7de";

  let fields = "";
  fields += renderDomainField(record, graph);
  if (record.type === "job") {
    fields += renderField("Narrative", record.narrative, "narrative", record.id, true);
    fields += renderField("Success looks like", record["success-looks-like"], "success-looks-like", record.id, true);
  } else if (record.type === "requirement") {
    const job = record.job ? graph.get(record.job) : null;
    fields += renderField("Behavior", record.behavior, "behavior", record.id, true);
    fields += renderField("Rationale", record.rationale, "rationale", record.id, true);
    if (job) fields += `<div class="field"><span class="label">Serves job</span><span class="field-value ref">${escape(job.title)}</span></div>`;
  } else if (record.type === "decision") {
    fields += renderField("Outcome", record.outcome, "outcome", record.id);
    fields += renderField("Rationale", record.rationale, "rationale", record.id, true);
    fields += renderField("Revisit when", record["revisit-when"], "revisit-when", record.id, true);
  } else if (record.type === "design-principle") {
    fields += renderField("Intent", record.intent, "intent", record.id, true);
  }

  const confidenceBadge = confidence
    ? `<span class="badge badge-${confidence}">${confidence}</span>` : "";
  const legitimacyBadge = `<span class="badge badge-${legitimacy}">${legitimacy}</span>`;
  const implBadge = implementation
    ? `<span class="badge badge-impl">${implementation}</span>` : "";

  const approveBtn = legitimacy === "proposed"
    ? `<button class="btn-approve" data-id="${record.id}" data-file="${escape(filePath)}">Approve</button>` : "";
  const saveBtn = `<button class="btn-save" data-id="${record.id}" data-file="${escape(filePath)}" style="display:none">Save</button>`;

  return `
    <div class="record"
      style="border-left:3px solid ${borderColor}"
      data-id="${record.id}"
      data-type="${record.type}"
      data-legitimacy="${legitimacy}"
      data-domain="${domain || ""}"
      data-screen="${record.screen || ""}"
      data-confidence="${confidence || ""}"
      data-implementation="${implementation || ""}">
      <div class="record-header">
        <div class="record-title">
          <span class="record-type">${record.type}</span>
          <span class="record-name">${escape(record.title)}</span>
        </div>
        <div class="record-badges">
          ${confidenceBadge}
          ${legitimacyBadge}
          ${implBadge}
          <span class="record-id">${record.id}</span>
        </div>
      </div>
      <div class="record-fields">${fields}</div>
      ${note ? `<div class="field warn"><span class="label">⚠ Note</span><span class="field-value">${escape(note)}</span></div>` : ""}
      ${source ? `<div class="field"><span class="label">Source</span><span class="field-value source">${escape(source)}</span></div>` : ""}
      <div class="record-actions">${approveBtn}${saveBtn}</div>
    </div>`;
}

// ─── Page generation ──────────────────────────────────────────────────────────

function generatePage(graph, args) {
  const domains = graph.all("domain").filter(d => d.status?.lifecycle === "active");
  const showAll = args.all;
  const filterDomain = args.domain;

  let allRecords = [];
  let domainSections = "";

  for (const domain of domains) {
    if (filterDomain && domain.id !== filterDomain) continue;

    let records = graph.byDomain(domain.id).filter(r => r.type !== "domain");
    if (!showAll) records = records.filter(r => r.status?.legitimacy === "proposed");
    if (records.length === 0) continue;

    allRecords = allRecords.concat(records);

    const byType = { job: [], requirement: [], decision: [], "design-principle": [] };
    records.forEach(r => { if (byType[r.type]) byType[r.type].push(r); });

    const typeLabels = { job: "Jobs", requirement: "Requirements", decision: "Decisions", "design-principle": "Design Principles" };
    let sections = "";
    for (const [type, typeRecords] of Object.entries(byType)) {
      if (!typeRecords.length) continue;
      sections += `<div class="type-section" data-type="${type}">
        <h3 class="type-heading">${typeLabels[type]} <span class="count">${typeRecords.length}</span></h3>
        ${typeRecords.map(r => {
          const meta = graph.records.get(r.id);
          const filePath = meta ? path.join(REQUIREMENTS_DIR, TYPE_DIRS[r.type], meta.file) : "";
          return renderRecord(r, filePath, graph);
        }).join("")}
      </div>`;
    }

    const lowConf = records.filter(r => r.meta?.["ingestion-confidence"] === "low").length;
    domainSections += `
      <div class="domain" id="${domain.id}" data-domain="${domain.id}">
        <div class="domain-header">
          <div>
            <h2 class="domain-title">${escape(domain.title)}</h2>
            <p class="domain-desc">${escape(domain.description)}</p>
          </div>
          <div class="domain-stats">
            <span class="stat">${records.length} records</span>
            ${lowConf > 0 ? `<span class="stat warn">⚠ ${lowConf} low confidence</span>` : ""}
          </div>
        </div>
        ${sections}
      </div>`;
  }

  const title = showAll ? "All Records" : "Proposed Records";
  const domainOptions = domains
    .filter(d => graph.byDomain(d.id).some(r => r.type !== "domain"))
    .map(d => `<option value="${d.id}">${escape(d.title)}</option>`)
    .join("");

  const screenSlugs = [...new Set(allRecords.map(r => r.screen).filter(Boolean))];
  const screenOptions = screenSlugs
    .map(slug => `<option value="${slug}">${escape(slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()))}</option>`)
    .join("");

  const navItems = domains
    .filter(d => {
      const recs = graph.byDomain(d.id).filter(r => r.type !== "domain" && (showAll || r.status?.legitimacy === "proposed"));
      return recs.length > 0 && (!filterDomain || d.id === filterDomain);
    })
    .map(d => {
      const count = graph.byDomain(d.id).filter(r => r.type !== "domain" && (showAll || r.status?.legitimacy === "proposed")).length;
      return `<a class="nav-item" href="#${d.id}">${escape(d.title)}<span class="nav-count">${count}</span></a>`;
    }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intent Review — ${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; color: #1f2328; background: #f6f8fa; }

    .header { background: #24292f; color: white; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; }
    .header h1 { font-size: 15px; font-weight: 600; }
    .header .subtitle { font-size: 12px; color: #8b949e; margin-top: 2px; }
    .approved-count { font-size: 12px; color: #3fb950; font-weight: 600; }

    .filter-bar { background: white; border-bottom: 1px solid #d0d7de; padding: 8px 24px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; position: sticky; top: 53px; z-index: 99; }
    .filter-group { display: flex; align-items: center; gap: 4px; }
    .filter-label { font-size: 11px; color: #656d76; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-right: 2px; }
    .filter-sep { width: 1px; height: 20px; background: #d0d7de; margin: 0 4px; }
    .filter-btn { padding: 3px 10px; border-radius: 20px; border: 1px solid #d0d7de; background: white; cursor: pointer; font-size: 11px; color: #656d76; }
    .filter-btn:hover { border-color: #0969da; color: #0969da; }
    .filter-btn.active { background: #0969da; color: white; border-color: #0969da; }
    .filter-btn.danger.active { background: #cf222e; border-color: #cf222e; }
    select.filter-select { padding: 3px 8px; border-radius: 6px; border: 1px solid #d0d7de; font-size: 11px; color: #1f2328; background: white; cursor: pointer; }

    .nav { width: 200px; position: fixed; top: 105px; left: 0; height: calc(100vh - 105px); overflow-y: auto; padding: 12px; background: white; border-right: 1px solid #d0d7de; }
    .nav-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #656d76; margin-bottom: 6px; }
    .nav-item { display: block; padding: 5px 8px; border-radius: 5px; color: #1f2328; text-decoration: none; font-size: 12px; margin-bottom: 1px; }
    .nav-item:hover { background: #f6f8fa; }
    .nav-count { float: right; color: #656d76; font-size: 11px; }

    .main { margin-left: 200px; padding: 20px 28px; max-width: 940px; }

    .domain { background: white; border: 1px solid #d0d7de; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
    .domain-header { padding: 14px 18px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; display: flex; justify-content: space-between; align-items: flex-start; }
    .domain-title { font-size: 16px; font-weight: 600; }
    .domain-desc { font-size: 12px; color: #656d76; margin-top: 3px; }
    .domain-stats { text-align: right; }
    .stat { display: inline-block; font-size: 11px; color: #656d76; margin-left: 10px; }
    .stat.warn { color: #cf222e; }

    .type-section { padding: 0 18px 14px; }
    .type-heading { font-size: 11px; font-weight: 600; color: #656d76; text-transform: uppercase; letter-spacing: .05em; padding: 14px 0 8px; border-bottom: 1px solid #f0f0f0; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    .count { background: #ddf4ff; color: #0969da; border-radius: 10px; padding: 1px 6px; font-size: 10px; font-weight: 600; text-transform: none; letter-spacing: 0; }

    .record { background: #fafafa; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 8px; padding: 12px 14px; transition: opacity .2s; }
    .record.approved-flash { border-left-color: #2da44e !important; background: #f0fff4; }
    .record.approved-done { opacity: .45; }
    .record-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; gap: 10px; }
    .record-title { flex: 1; }
    .record-type { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: #656d76; display: block; margin-bottom: 2px; }
    .record-name { font-size: 13px; font-weight: 600; color: #1f2328; line-height: 1.4; }
    .record-badges { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
    .record-id { font-size: 10px; color: #8b949e; font-family: monospace; }

    .badge { padding: 2px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; color: white; }
    .badge-proposed { background: #bf8700; }
    .badge-approved { background: #2da44e; }
    .badge-superseded { background: #656d76; }
    .badge-high { background: #2da44e; }
    .badge-medium { background: #bf8700; }
    .badge-low { background: #cf222e; }
    .badge-impl { background: #6e40c9; }

    .record-fields { }
    .field { display: flex; gap: 10px; margin-bottom: 5px; font-size: 12px; align-items: flex-start; }
    .field.warn { background: #fff8c5; padding: 5px 7px; border-radius: 4px; margin-top: 6px; }
    .label { color: #656d76; min-width: 110px; flex-shrink: 0; font-weight: 500; padding-top: 3px; }
    .field-edit-wrap { flex: 1; }
    .field-value { color: #1f2328; line-height: 1.5; display: block; border-radius: 3px; }
    .field-value:not(.ref):not(.source):hover { background: #f0f4f8; cursor: text; }
    .field-value.ref { color: #0969da; }
    .field-value.source { color: #656d76; font-style: italic; font-size: 11px; }
    .field-input { display: none; width: 100%; padding: 4px 6px; border: 1px solid #0969da; border-radius: 4px; font-size: 12px; font-family: inherit; resize: vertical; }
    .record.editing .field-value { display: none; }
    .record.editing .field-input { display: block; }

    .record-actions { margin-top: 10px; display: flex; gap: 6px; }
    .btn-approve { padding: 4px 12px; background: #2da44e; color: white; border: none; border-radius: 5px; font-size: 12px; font-weight: 600; cursor: pointer; margin-left: auto; }
    .btn-approve:hover { background: #218a3c; }
    .btn-save { padding: 4px 12px; background: #0969da; color: white; border: none; border-radius: 5px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn-save:hover { background: #0550a8; }
    .btn-edit { padding: 4px 10px; background: white; color: #656d76; border: 1px solid #d0d7de; border-radius: 5px; font-size: 12px; cursor: pointer; }
    .btn-edit:hover { border-color: #0969da; color: #0969da; }
    .btn-cancel { padding: 4px 10px; background: white; color: #656d76; border: 1px solid #d0d7de; border-radius: 5px; font-size: 12px; cursor: pointer; }

    .toast { position: fixed; bottom: 24px; right: 24px; background: #1f2328; color: white; padding: 10px 16px; border-radius: 6px; font-size: 13px; opacity: 0; transition: opacity .2s; z-index: 1000; pointer-events: none; }
    .toast.show { opacity: 1; }

    .empty { text-align: center; padding: 60px; color: #656d76; }
    .empty h2 { font-size: 18px; margin-bottom: 8px; }
  </style>
</head>
<body>

<div class="header">
  <div>
    <h1>Intent Review — ${title}</h1>
    <div class="subtitle" id="subtitle">${allRecords.length} records · ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
  </div>
  <div style="display:flex;align-items:center;gap:16px">
    <span class="approved-count" id="approvedCount"></span>
    <button id="publishBtn" onclick="runPublish()" style="padding:5px 14px;border-radius:5px;font-size:12px;font-weight:600;color:white;background:#2da44e;border:none;cursor:pointer">Publish</button>
    <nav style="display:flex;gap:4px">
      <a href="/ingest" style="padding:5px 14px;border-radius:5px;font-size:12px;font-weight:500;color:#8b949e;text-decoration:none">Ingest</a>
      <a href="/" style="padding:5px 14px;border-radius:5px;font-size:12px;font-weight:500;color:white;background:rgba(255,255,255,.15);text-decoration:none">Review</a>
    </nav>
  </div>
</div>

<div class="filter-bar">
  <div class="filter-group">
    <span class="filter-label">Type</span>
    <button class="filter-btn active" data-filter="type" data-value="all">All</button>
    <button class="filter-btn" data-filter="type" data-value="requirement">Requirements</button>
    <button class="filter-btn" data-filter="type" data-value="job">Jobs</button>
    <button class="filter-btn" data-filter="type" data-value="decision">Decisions</button>
    <button class="filter-btn" data-filter="type" data-value="design-principle">Principles</button>
  </div>
  <div class="filter-sep"></div>
  <div class="filter-group">
    <span class="filter-label">Status</span>
    <button class="filter-btn active" data-filter="legitimacy" data-value="all">All</button>
    <button class="filter-btn" data-filter="legitimacy" data-value="proposed">Proposed</button>
    <button class="filter-btn" data-filter="legitimacy" data-value="approved">Approved</button>
  </div>
  <div class="filter-sep"></div>
  <div class="filter-group">
    <span class="filter-label">Confidence</span>
    <button class="filter-btn active" data-filter="confidence" data-value="all">All</button>
    <button class="filter-btn" data-filter="confidence" data-value="high">High</button>
    <button class="filter-btn" data-filter="confidence" data-value="medium">Medium</button>
    <button class="filter-btn" data-filter="confidence" data-value="low" style="color:#cf222e;border-color:#cf222e">Low</button>
  </div>
  <div class="filter-sep"></div>
  <div class="filter-group">
    <span class="filter-label">Built</span>
    <button class="filter-btn active" data-filter="implementation" data-value="all">All</button>
    <button class="filter-btn" data-filter="implementation" data-value="unbuilt">Unbuilt</button>
    <button class="filter-btn" data-filter="implementation" data-value="partial">Partial</button>
    <button class="filter-btn" data-filter="implementation" data-value="complete">Complete</button>
  </div>
  <div class="filter-sep"></div>
  <div class="filter-group">
    <span class="filter-label">Domain</span>
    <select class="filter-select" id="domainFilter">
      <option value="all">All domains</option>
      ${domainOptions}
    </select>
  </div>
  ${screenOptions ? `<div class="filter-sep"></div>
  <div class="filter-group">
    <span class="filter-label">Screen</span>
    <select class="filter-select" id="screenFilter">
      <option value="all">All screens</option>
      ${screenOptions}
    </select>
  </div>` : ""}
</div>

<nav class="nav">
  <div class="nav-label">Domains</div>
  ${navItems}
</nav>

<div class="main" id="main">
  ${domainSections || `<div class="empty"><h2>No records to review</h2><p>Run with --all to see approved records too.</p></div>`}
</div>

<div class="toast" id="toast"></div>

<script>
  const filters = { type: 'all', legitimacy: 'all', confidence: 'all', implementation: 'all', domain: 'all', screen: 'all' };
  let approvedThisSession = 0;

  function applyFilters() {
    document.querySelectorAll('.record').forEach(r => {
      const show =
        (filters.type === 'all' || r.dataset.type === filters.type) &&
        (filters.legitimacy === 'all' || r.dataset.legitimacy === filters.legitimacy) &&
        (filters.confidence === 'all' || r.dataset.confidence === filters.confidence) &&
        (filters.implementation === 'all' || r.dataset.implementation === filters.implementation) &&
        (filters.domain === 'all' || r.dataset.domain === filters.domain) &&
        (filters.screen === 'all' || r.dataset.screen === filters.screen);
      r.style.display = show ? '' : 'none';
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

  document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.filter;
      document.querySelectorAll(\`.filter-btn[data-filter="\${group}"]\`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filters[group] = btn.dataset.value;
      applyFilters();
    });
  });

  document.getElementById('domainFilter').addEventListener('change', e => {
    filters.domain = e.target.value;
    applyFilters();
  });

  const screenFilterEl = document.getElementById('screenFilter');
  if (screenFilterEl) {
    screenFilterEl.addEventListener('change', e => {
      filters.screen = e.target.value;
      applyFilters();
    });
  }

  function showToast(msg, error = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.background = error ? '#cf222e' : '#1f2328';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }

  function updateApprovedCount() {
    const el = document.getElementById('approvedCount');
    if (approvedThisSession > 0) el.textContent = approvedThisSession + ' approved this session';
  }

  // Approve
  document.addEventListener('click', async e => {
    if (!e.target.classList.contains('btn-approve')) return;
    const btn = e.target;
    const id = btn.dataset.id;
    const file = btn.dataset.file;
    btn.disabled = true;
    btn.textContent = 'Approving…';
    try {
      const res = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, file })
      });
      if (!res.ok) throw new Error(await res.text());
      const card = document.querySelector(\`.record[data-id="\${id}"]\`);
      card.dataset.legitimacy = 'approved';
      card.classList.add('approved-flash');
      setTimeout(() => card.classList.add('approved-done'), 600);
      btn.remove();
      approvedThisSession++;
      updateApprovedCount();
      showToast('Approved: ' + id);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Approve';
      showToast('Error: ' + err.message, true);
    }
  });

  // Edit toggle
  document.addEventListener('click', e => {
    if (!e.target.classList.contains('btn-edit')) return;
    const card = e.target.closest('.record');
    card.classList.add('editing');
    e.target.style.display = 'none';
    card.querySelector('.btn-save').style.display = '';
    card.querySelector('.btn-cancel') && (card.querySelector('.btn-cancel').style.display = '');
  });

  document.addEventListener('click', e => {
    if (!e.target.classList.contains('btn-cancel')) return;
    const card = e.target.closest('.record');
    card.classList.remove('editing');
    card.querySelector('.btn-edit') && (card.querySelector('.btn-edit').style.display = '');
    card.querySelector('.btn-save').style.display = 'none';
    e.target.style.display = 'none';
  });

  // Save edits
  document.addEventListener('click', async e => {
    if (!e.target.classList.contains('btn-save')) return;
    const btn = e.target;
    const id = btn.dataset.id;
    const file = btn.dataset.file;
    const card = btn.closest('.record');
    const fields = {};
    card.querySelectorAll('.field-input').forEach(input => {
      if (input.dataset.field) fields[input.dataset.field] = input.value || input.textContent;
    });
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, file, fields })
      });
      if (!res.ok) throw new Error(await res.text());
      card.querySelectorAll('.field-input').forEach(input => {
        const val = input.value || input.textContent;
        const valueEl = input.closest('.field-edit-wrap')?.querySelector('.field-value');
        if (valueEl) valueEl.textContent = val;
      });
      card.classList.remove('editing');
      card.querySelector('.btn-edit') && (card.querySelector('.btn-edit').style.display = '');
      btn.textContent = 'Save';
      btn.style.display = 'none';
      btn.disabled = false;
      card.querySelector('.btn-cancel') && (card.querySelector('.btn-cancel').style.display = 'none');
      showToast('Saved: ' + id);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Save';
      showToast('Error: ' + err.message, true);
    }
  });

  // Domain dropdown: auto-save on change, or show new domain form
  document.addEventListener('change', async e => {
    if (!e.target.classList.contains('domain-select')) return;
    const select = e.target;
    const card = select.closest('.record');
    const id = select.dataset.id;
    const file = card.querySelector('.btn-save')?.dataset.file;
    if (!file) return;

    if (select.value === '__new__') {
      const title = prompt('New domain name:');
      if (!title) { select.value = select.dataset.prev || ''; return; }
      const description = prompt('One-line description:') || '';
      try {
        const res = await fetch('/api/domain/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, description })
        });
        if (!res.ok) throw new Error(await res.text());
        const domain = await res.json();
        // Add to all domain selects on the page
        document.querySelectorAll('.domain-select').forEach(s => {
          const opt = document.createElement('option');
          opt.value = domain.id; opt.textContent = title;
          s.insertBefore(opt, s.querySelector('option[value="__new__"]'));
        });
        select.value = domain.id;
        showToast('Domain created: ' + title);
      } catch (err) {
        showToast('Error: ' + err.message, true);
        select.value = select.dataset.prev || '';
        return;
      }
    }

    select.dataset.prev = select.value;
    const displayEl = select.closest('.field-edit-wrap')?.querySelector('.field-value');
    if (displayEl) displayEl.textContent = select.options[select.selectedIndex].text;

    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, file, fields: { domain: select.value } })
      });
      if (!res.ok) throw new Error(await res.text());
      card.dataset.domain = select.value;
      showToast('Domain updated');
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  });

  // Publish
  async function runPublish() {
    const btn = document.getElementById('publishBtn');
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    try {
      const res = await fetch('/api/publish', { method: 'POST' });
      const { output, ok } = await res.json();
      showToast(ok ? 'Published — PR opened' : 'Publish failed', !ok);
      console.log(output);
    } catch (e) {
      showToast('Publish error: ' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Publish';
    }
  }

  // Store initial domain value for cancel support
  document.querySelectorAll('.domain-select').forEach(s => { s.dataset.prev = s.value; });

  // Add edit/cancel buttons to each record
  document.querySelectorAll('.record').forEach(card => {
    const actions = card.querySelector('.record-actions');
    if (!actions) return;
    const saveBtn = actions.querySelector('.btn-save');
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-edit';
    editBtn.textContent = 'Edit';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.display = 'none';
    actions.prepend(cancelBtn);
    actions.prepend(saveBtn || cancelBtn);
    actions.prepend(editBtn);
    if (saveBtn) editBtn.after(saveBtn);
  });
</script>
</body>
</html>`;
}

// ─── Ingest page ─────────────────────────────────────────────────────────────

function generateIngestPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intent — Ingest</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; color: #1f2328; background: #f6f8fa; }

    .header { background: #24292f; color: white; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; }
    .header h1 { font-size: 15px; font-weight: 600; }
    .nav-tabs { display: flex; gap: 4px; }
    .nav-tab { padding: 5px 14px; border-radius: 5px; font-size: 12px; font-weight: 500; color: #8b949e; text-decoration: none; }
    .nav-tab:hover { color: white; background: rgba(255,255,255,.1); }
    .nav-tab.active { color: white; background: rgba(255,255,255,.15); }

    .main { max-width: 700px; margin: 40px auto; padding: 0 24px; }
    h2 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
    .desc { font-size: 13px; color: #656d76; margin-bottom: 24px; }

    .form-section { background: white; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .form-label { font-size: 12px; font-weight: 600; color: #1f2328; display: block; margin-bottom: 6px; }
    .form-hint { font-size: 11px; color: #656d76; margin-bottom: 8px; }
    input[type="text"], textarea { width: 100%; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; font-family: inherit; }
    input[type="text"]:focus, textarea:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 3px rgba(9,105,218,.1); }
    textarea { resize: vertical; min-height: 120px; }
    .or-divider { text-align: center; color: #656d76; font-size: 12px; margin: 12px 0; }

    .options { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
    .option-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #656d76; }
    input[type="checkbox"] { width: 14px; height: 14px; }

    .btn-run { margin-top: 20px; padding: 8px 20px; background: #0969da; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn-run:hover { background: #0550a8; }
    .btn-run:disabled { background: #8c959f; cursor: not-allowed; }

    .output-section { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-top: 20px; display: none; }
    .output-section.visible { display: block; }
    .output-log { font-family: "SF Mono", "Fira Code", monospace; font-size: 12px; color: #c9d1d9; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; }
    .output-status { font-size: 12px; color: #8b949e; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
    .spinner { width: 12px; height: 12px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .done-bar { margin-top: 14px; padding-top: 14px; border-top: 1px solid #30363d; display: none; }
    .done-bar.visible { display: flex; gap: 10px; align-items: center; }
    .btn-review { padding: 6px 16px; background: #2da44e; color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-block; }
    .done-msg { font-size: 12px; color: #8b949e; }
  </style>
</head>
<body>
<div class="header">
  <h1>Intent Harness</h1>
  <nav class="nav-tabs">
    <a class="nav-tab active" href="/ingest">Ingest</a>
    <a class="nav-tab" href="/">Review</a>
  </nav>
</div>

<div class="main">
  <h2>Ingest documentation</h2>
  <p class="desc">Point the agent at existing docs and it will extract requirement records for your review. Records are written locally — nothing is approved until you review and merge.</p>

  <div class="form-section">
    <label class="form-label">File path or URL</label>
    <p class="form-hint">Path to a file, directory, or URL. Comma-separate multiple sources.</p>
    <input type="text" id="fromInput" placeholder="./docs/spec.md  or  https://notion.so/your-page">

    <div class="or-divider">— or paste content directly —</div>

    <label class="form-label">Paste text</label>
    <p class="form-hint">Paste a spec, PRD, meeting notes, or any documentation.</p>
    <textarea id="pasteInput" placeholder="Paste your documentation here…"></textarea>

    <div class="options">
      <label class="option-check">
        <input type="checkbox" id="noPrCheck" checked>
        Write files locally (no PR)
      </label>
      <label class="option-check">
        <input type="checkbox" id="dryRunCheck">
        Dry run (don't write files)
      </label>
    </div>

    <button class="btn-run" id="runBtn" onclick="runIngest()">Run ingest</button>
  </div>

  <div class="output-section" id="outputSection">
    <div class="output-status" id="outputStatus">
      <div class="spinner" id="spinner"></div>
      <span id="statusText">Running…</span>
    </div>
    <div class="output-log" id="outputLog"></div>
    <div class="done-bar" id="doneBar">
      <a class="btn-review" href="/">Go to Review →</a>
      <span class="done-msg" id="doneMsg"></span>
    </div>
  </div>
</div>

<script>
  window.addEventListener('load', async () => {
    const { id, running } = await fetch('/api/ingest-active').then(r => r.json());
    if (running) {
      document.getElementById('outputSection').classList.add('visible');
      document.getElementById('statusText').textContent = 'Running… (reconnected)';
      document.getElementById('runBtn').disabled = true;
      document.getElementById('runBtn').textContent = 'Running…';
      startPolling(id, false);
    }
  });

  function startPolling(jobId, dryRun) {
    let offset = 0;
    const outputLog = document.getElementById('outputLog');
    const spinner = document.getElementById('spinner');
    const statusText = document.getElementById('statusText');
    const doneBar = document.getElementById('doneBar');
    const doneMsg = document.getElementById('doneMsg');
    const btn = document.getElementById('runBtn');

    const poll = setInterval(async () => {
      try {
        const { output, done, error } = await fetch('/api/ingest-status?id=' + jobId).then(r => r.json());
        if (output.length > offset) {
          outputLog.textContent += output.slice(offset);
          offset = output.length;
          outputLog.scrollTop = outputLog.scrollHeight;
        }
        if (done) {
          clearInterval(poll);
          spinner.style.display = 'none';
          statusText.textContent = error ? 'Failed' : 'Done';
          doneBar.classList.add('visible');
          doneMsg.textContent = error || (dryRun ? 'Dry run complete.' : 'Records written. Go to Review to approve them.');
          btn.disabled = false; btn.textContent = 'Run ingest';
        }
      } catch (e) {
        clearInterval(poll);
        outputLog.textContent += '\\nPoll error: ' + e.message;
        spinner.style.display = 'none';
        btn.disabled = false; btn.textContent = 'Run ingest';
      }
    }, 800);
  }

  async function runIngest() {
    const fromVal = document.getElementById('fromInput').value.trim();
    const pasteVal = document.getElementById('pasteInput').value.trim();
    const noPr = document.getElementById('noPrCheck').checked;
    const dryRun = document.getElementById('dryRunCheck').checked;

    if (!fromVal && !pasteVal) {
      alert('Please provide a file path or paste some content.');
      return;
    }

    const btn = document.getElementById('runBtn');
    btn.disabled = true;
    btn.textContent = 'Running…';

    const outputSection = document.getElementById('outputSection');
    const outputLog = document.getElementById('outputLog');
    const statusText = document.getElementById('statusText');
    const spinner = document.getElementById('spinner');
    const doneBar = document.getElementById('doneBar');
    const doneMsg = document.getElementById('doneMsg');

    outputSection.classList.add('visible');
    outputLog.textContent = '';
    doneBar.classList.remove('visible');
    spinner.style.display = '';
    statusText.textContent = 'Running…';

    let jobId;
    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: fromVal, paste: pasteVal, noPr, dryRun })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      jobId = data.id;
    } catch (err) {
      outputLog.textContent = 'Error: ' + err.message;
      statusText.textContent = 'Failed';
      spinner.style.display = 'none';
      btn.disabled = false; btn.textContent = 'Run ingest';
      return;
    }

    startPolling(jobId, dryRun);

    btn.disabled = false;
    btn.textContent = 'Run ingest';
  }
</script>
</body>
</html>`;
}

// ─── YAML write helpers ───────────────────────────────────────────────────────

function approveRecord(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const record = yaml.load(raw);
  record.status = record.status || {};
  record.status.legitimacy = "approved";
  record.meta = record.meta || {};
  record.meta["approved-date"] = new Date().toISOString().split("T")[0];
  fs.writeFileSync(filePath, yaml.dump(record, { lineWidth: 120 }), "utf8");
}

function updateRecord(filePath, fields) {
  const raw = fs.readFileSync(filePath, "utf8");
  const record = yaml.load(raw);
  for (const [key, value] of Object.entries(fields)) {
    if (key === "id") continue; // never update id
    record[key] = value;
  }
  record.meta = record.meta || {};
  record.meta.updated = new Date().toISOString().split("T")[0];
  fs.writeFileSync(filePath, yaml.dump(record, { lineWidth: 120 }), "utf8");
}

// ─── Server ───────────────────────────────────────────────────────────────────

const TYPE_DIRS = {
  job: "jobs", domain: "domains", "design-principle": "design-principles",
  "design-spec": "design-specs", requirement: "requirements", decision: "decisions",
};

function startServer(graph, args, port) {
  const html = generatePage(graph, args);
  const ingestHtml = generateIngestPage();
  const agentScript = path.join(__dirname, "agents", "ingest-agent.js");
  const jobs = new Map(); // id -> { output, done, error }
  let activeJobId = null;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && req.url === "/ingest") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ingestHtml);
      return;
    }

    if (req.method === "POST" && req.url === "/api/ingest") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const { from, paste, noPr, dryRun } = JSON.parse(body);

          let sources = from || "";
          let tempFile = null;
          if (paste && paste.trim()) {
            tempFile = path.join(INTENT_ROOT, ".intent", "_ingest_paste.txt");
            fs.writeFileSync(tempFile, paste, "utf8");
            sources = sources ? `${sources},${tempFile}` : tempFile;
          }

          if (!sources) {
            res.writeHead(400); res.end(JSON.stringify({ error: "No source provided" })); return;
          }

          if (activeJobId && !jobs.get(activeJobId)?.done) {
            res.writeHead(409); res.end(JSON.stringify({ error: "An ingest is already running" })); return;
          }

          const id = Math.random().toString(36).slice(2);
          activeJobId = id;
          const job = { output: "", done: false, error: null };
          jobs.set(id, job);

          const nodeArgs = [`--from=${sources}`];
          if (noPr) nodeArgs.push("--no-pr");
          if (dryRun) nodeArgs.push("--dry-run");

          console.log(`  Ingest [${id}]: ${nodeArgs.join(" ")}`);

          const child = spawn("node", [agentScript, ...nodeArgs], {
            env: { ...process.env, INTENT_ROOT, FORCE_COLOR: "0" },
            cwd: INTENT_ROOT,
          });

          child.stdout.on("data", d => { job.output += d.toString(); });
          child.stderr.on("data", d => { job.output += d.toString(); });
          child.on("close", (code, signal) => {
            if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            job.done = true;
            job.error = code !== 0 ? `Exit ${code ?? "null"} signal ${signal ?? "none"}` : null;
            console.log(`  Ingest [${id}] done. code=${code}`);
          });

          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id }));
        } catch (err) {
          res.writeHead(500); res.end(err.message);
        }
      });
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/ingest-status")) {
      const id = req.url.split("id=")[1];
      const job = jobs.get(id);
      if (!job) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: job.output, done: job.done, error: job.error }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/domain/create") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const { title, description } = JSON.parse(body);
          if (!title) { res.writeHead(400); res.end("title required"); return; }
          const id = "dom_" + Math.random().toString(36).slice(2, 10);
          const record = {
            id, type: "domain", title, description: description || "",
            status: { legitimacy: "proposed", lifecycle: "active" },
            meta: { created: new Date().toISOString().split("T")[0] },
          };
          const dir = path.join(REQUIREMENTS_DIR, "domains");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${id}.yaml`), yaml.dump(record, { lineWidth: 120 }), "utf8");
          console.log(`  ✓ Created domain: ${title} (${id})`);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id, title, description: description || "" }));
        } catch (err) {
          res.writeHead(500); res.end(err.message);
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/api/ingest-active") {
      const job = activeJobId ? jobs.get(activeJobId) : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: activeJobId, running: !!(job && !job.done) }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/publish") {
      const agentScript = path.join(__dirname, "intent.js");
      const child = spawn("node", [agentScript, "publish"], {
        env: { ...process.env, INTENT_ROOT },
        cwd: INTENT_ROOT,
      });
      let output = "";
      child.stdout.on("data", d => { output += d; });
      child.stderr.on("data", d => { output += d; });
      child.on("close", code => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ output, ok: code === 0 }));
      });
      return;
    }

    if (req.method === "POST" && (req.url === "/api/approve" || req.url === "/api/update")) {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        try {
          const { id, file, fields } = JSON.parse(body);
          if (!file || !fs.existsSync(file)) {
            res.writeHead(400); res.end("File not found: " + file); return;
          }
          if (req.url === "/api/approve") {
            approveRecord(file);
            console.log(`  ✓ Approved: ${id}`);
          } else {
            updateRecord(file, fields || {});
            console.log(`  ✓ Updated: ${id}`);
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500); res.end(err.message);
        }
      });
      return;
    }

    res.writeHead(404); res.end("Not found");
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`\n✓ Review server running at ${url}`);
    console.log(`  Ctrl+C to stop\n`);
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execSync(`${opener} "${url}"`);
    } catch {}
  });

  process.on("SIGINT", () => { console.log("\n  Stopped.\n"); process.exit(0); });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = parseArgs();
const port = parseInt(args.port) || 3131;
const graph = new Graph(REQUIREMENTS_DIR);

startServer(graph, args, port);
