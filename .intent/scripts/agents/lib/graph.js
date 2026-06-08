"use strict";

/**
 * graph.js
 *
 * Loads all requirement records from the repo and provides
 * query methods the spec agent uses to build context before
 * calling Claude.
 *
 * Designed to be cheap to instantiate — loads once per agent run.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const TYPE_DIRS = {
  job: "jobs",
  domain: "domains",
  "design-principle": "design-principles",
  "design-spec": "design-specs",
  requirement: "requirements",
  decision: "decisions",
};

class Graph {
  constructor(requirementsRoot) {
    this.root = requirementsRoot;
    this.records = new Map(); // id -> { record, type, file }
    this._load();
  }

  _load() {
    for (const [type, dir] of Object.entries(TYPE_DIRS)) {
      const fullDir = path.join(this.root, dir);
      if (!fs.existsSync(fullDir)) continue;
      const files = fs
        .readdirSync(fullDir)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
      for (const file of files) {
        try {
          const record = yaml.load(
            fs.readFileSync(path.join(fullDir, file), "utf8")
          );
          if (record?.id) {
            this.records.set(record.id, { record, type, file });
          }
        } catch (e) {
          // skip malformed
        }
      }
    }
  }

  get(id) {
    return this.records.get(id)?.record || null;
  }

  getWithMeta(id) {
    return this.records.get(id) || null;
  }

  all(type) {
    return [...this.records.values()]
      .filter((r) => !type || r.type === type)
      .map((r) => r.record);
  }

  /**
   * Returns all records belonging to a domain.
   */
  byDomain(domainId) {
    return [...this.records.values()]
      .filter((r) => r.record.domain === domainId)
      .map((r) => r.record);
  }

  /**
   * Finds the most likely domain for a piece of text by
   * scoring domain titles and descriptions against keywords.
   * Returns the best-matching domain record or null.
   */
  inferDomain(text) {
    const lower = text.toLowerCase();
    let best = null;
    let bestScore = 0;

    for (const { record, type } of this.records.values()) {
      if (type !== "domain") continue;
      if (record.status?.lifecycle !== "active") continue;

      let score = 0;
      const title = (record.title || "").toLowerCase();
      const desc = (record.description || "").toLowerCase();
      const includes = (record.boundary?.includes || []).join(" ").toLowerCase();

      // Title words present in text
      for (const word of title.split(/\s+/)) {
        if (word.length > 3 && lower.includes(word)) score += 3;
      }

      // Description keywords
      for (const word of desc.split(/\s+/)) {
        if (word.length > 4 && lower.includes(word)) score += 1;
      }

      // Boundary includes
      for (const item of includes.split(/\s+/)) {
        if (item.length > 4 && lower.includes(item)) score += 2;
      }

      if (score > bestScore) {
        bestScore = score;
        best = record;
      }
    }

    return bestScore > 0 ? best : null;
  }

  /**
   * Finds approved+active requirements that may relate to a text description.
   * Used to surface existing requirements before drafting new ones.
   */
  findRelated(text, domainId = null) {
    const lower = text.toLowerCase();
    const results = [];

    for (const { record, type } of this.records.values()) {
      if (type !== "requirement") continue;
      if (record.status?.legitimacy !== "approved") continue;
      if (record.status?.lifecycle !== "active") continue;
      if (domainId && record.domain !== domainId) continue;

      const title = (record.title || "").toLowerCase();
      const behavior = (record.behavior || "").toLowerCase();
      let score = 0;

      for (const word of lower.split(/\s+/)) {
        if (word.length > 4) {
          if (title.includes(word)) score += 3;
          if (behavior.includes(word)) score += 1;
        }
      }

      if (score > 2) results.push({ record, score });
    }

    return results.sort((a, b) => b.score - a.score).map((r) => r.record);
  }

  /**
   * Returns all design specs linked to a requirement.
   * Used to detect staleness after a requirement update.
   */
  designSpecsForRequirement(requirementId) {
    return [...this.records.values()]
      .filter(
        ({ record, type }) =>
          type === "design-spec" && record.requirement === requirementId
      )
      .map((r) => r.record);
  }

  /**
   * Returns all active decisions constraining a requirement.
   */
  decisionsFor(requirementId) {
    const req = this.get(requirementId);
    if (!req) return [];

    const decisionIds = [
      ...(req.relationships?.depends_on || []).filter((id) =>
        id.startsWith("dec_")
      ),
      ...(req.relationships?.related || []).filter((id) =>
        id.startsWith("dec_")
      ),
    ];

    return decisionIds
      .map((id) => this.get(id))
      .filter(
        (d) =>
          d &&
          d.status?.legitimacy === "approved" &&
          d.status?.lifecycle === "active"
      );
  }

  /**
   * Serializes a compact summary of the graph for inclusion
   * in Claude prompts. Keeps token count manageable by
   * summarizing rather than dumping full records.
   */
  summarize(domainId = null) {
    const domains = this.all("domain").filter(
      (d) => !domainId || d.id === domainId
    );

    const jobs = this.all("job").filter(
      (j) => !domainId || j.domain === domainId
    );

    const requirements = this.all("requirement").filter(
      (r) =>
        (!domainId || r.domain === domainId) &&
        r.status?.legitimacy === "approved" &&
        r.status?.lifecycle === "active"
    );

    const decisions = this.all("decision").filter(
      (d) =>
        (!domainId || d.domain === domainId) &&
        d.status?.legitimacy === "approved" &&
        d.status?.lifecycle === "active"
    );

    const principles = this.all("design-principle").filter(
      (dp) =>
        (!domainId || dp.domain === domainId) &&
        dp.status?.legitimacy === "approved"
    );

    const lines = [];

    if (domains.length) {
      lines.push("## Domains");
      domains.forEach((d) =>
        lines.push(`- [${d.id}] ${d.title}: ${d.description?.slice(0, 100)}`)
      );
    }

    if (jobs.length) {
      lines.push("\n## Jobs");
      jobs.forEach((j) =>
        lines.push(`- [${j.id}] ${j.title}`)
      );
    }

    if (requirements.length) {
      lines.push("\n## Approved requirements");
      requirements.forEach((r) =>
        lines.push(`- [${r.id}] ${r.title} (${r.status?.implementation})`)
      );
    }

    if (decisions.length) {
      lines.push("\n## Active decisions");
      decisions.forEach((d) =>
        lines.push(`- [${d.id}] ${d.title} (${d.outcome})`)
      );
    }

    if (principles.length) {
      lines.push("\n## Design principles");
      principles.forEach((dp) => lines.push(`- [${dp.id}] ${dp.title}`));
    }

    return lines.join("\n");
  }

  /**
   * File path for a new record of a given type.
   */
  pathFor(type, id) {
    const dir = TYPE_DIRS[type];
    if (!dir) throw new Error(`Unknown type: ${type}`);
    return path.join(this.root, dir, `${id}.yaml`);
  }
}

module.exports = { Graph };
