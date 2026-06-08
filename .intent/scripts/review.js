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
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const { Graph } = require("./agents/lib/graph");

const INTENT_ROOT = process.env.INTENT_ROOT || process.cwd();
const REQUIREMENTS_DIR = path.join(INTENT_ROOT, "requirements");

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

function renderRecord(record, filePath, graph) {
  const confidence = record.meta?.["ingestion-confidence"];
  const note = record.meta?.["ingestion-note"];
  const source = record.meta?.["ingestion-source"];
  const legitimacy = record.status?.legitimacy;
  const implementation = record.status?.implementation;
  const domain = record.domain;

  const borderColor = legitimacy === "approved" ? "#2da44e" : confidence === "low" ? "#cf222e" : "#d0d7de";

  let fields = "";
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
    .field-value { color: #1f2328; line-height: 1.5; display: block; }
    .field-value.ref { color: #0969da; }
    .field-value.source { color: #656d76; font-style: italic; font-size: 11px; }
    .field-input { display: none; width: 100%; padding: 4px 6px; border: 1px solid #0969da; border-radius: 4px; font-size: 12px; font-family: inherit; resize: vertical; }
    .record.editing .field-value { display: none; }
    .record.editing .field-input { display: block; }

    .record-actions { margin-top: 10px; display: flex; gap: 6px; }
    .btn-approve { padding: 4px 12px; background: #2da44e; color: white; border: none; border-radius: 5px; font-size: 12px; font-weight: 600; cursor: pointer; }
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
  <span class="approved-count" id="approvedCount"></span>
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
  const filters = { type: 'all', legitimacy: 'all', confidence: 'all', implementation: 'all', domain: 'all' };
  let approvedThisSession = 0;

  function applyFilters() {
    document.querySelectorAll('.record').forEach(r => {
      const show =
        (filters.type === 'all' || r.dataset.type === filters.type) &&
        (filters.legitimacy === 'all' || r.dataset.legitimacy === filters.legitimacy) &&
        (filters.confidence === 'all' || r.dataset.confidence === filters.confidence) &&
        (filters.implementation === 'all' || r.dataset.implementation === filters.implementation) &&
        (filters.domain === 'all' || r.dataset.domain === filters.domain);
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
    actions.appendChild(editBtn);
    actions.appendChild(cancelBtn);
    if (saveBtn) saveBtn.after(cancelBtn);
  });
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

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
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
