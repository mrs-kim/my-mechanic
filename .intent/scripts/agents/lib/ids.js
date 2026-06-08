"use strict";

/**
 * Opaque permanent ID generation.
 *
 * Format: {prefix}_{nanoid}
 * IDs encode only type — no meaning, no structure.
 * They never change after creation.
 */

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function nanoid(len = 8) {
  // crypto.randomBytes is available in Node 18+
  const { randomBytes } = require("crypto");
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join("");
}

const PREFIXES = {
  job: "job",
  domain: "dom",
  "design-principle": "dp",
  "design-spec": "ds",
  requirement: "req",
  decision: "dec",
};

function generateId(type) {
  const prefix = PREFIXES[type];
  if (!prefix) throw new Error(`Unknown record type: ${type}`);
  return `${prefix}_${nanoid()}`;
}

function typeFromId(id) {
  const prefix = id.split("_")[0];
  const map = {
    job: "job",
    dom: "domain",
    dp: "design-principle",
    ds: "design-spec",
    req: "requirement",
    dec: "decision",
  };
  return map[prefix] || null;
}

module.exports = { generateId, typeFromId, nanoid };
