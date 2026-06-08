"use strict";

/**
 * fetcher.js
 *
 * Reads input documents from multiple sources and returns
 * normalized chunks the extractor can work with.
 *
 * Supported sources:
 *   - Local files (.md, .txt, .html, .json, .yaml)
 *   - Directories (reads all supported files recursively)
 *   - HTTP/HTTPS URLs (fetches and strips to plain text)
 *   - Stdin (piped content)
 *
 * Returns an array of { source, content } objects.
 * Content is always plain text — HTML is stripped.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const SUPPORTED_EXTENSIONS = [".md", ".txt", ".html", ".htm", ".json", ".yaml", ".yml"];
const MAX_FILE_SIZE_BYTES = 500_000; // 500KB per file — beyond this, chunk differently

// ─── HTML stripping ───────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

// ─── URL fetch ────────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers: { "User-Agent": "intent-harness-ingest/0.1" } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        const contentType = res.headers["content-type"] || "";
        if (contentType.includes("html")) {
          resolve(stripHtml(raw));
        } else {
          resolve(raw);
        }
      });
    }).on("error", reject);
  });
}

// ─── File reading ─────────────────────────────────────────────────────────────

function readFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    console.warn(`  ⚠ ${filePath} is large (${Math.round(stat.size / 1024)}KB) — will be chunked`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".html" || ext === ".htm") {
    return stripHtml(content);
  }

  return content;
}

function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
        results.push(...walkDir(fullPath));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 6000; // characters — roughly 1500 tokens, leaves room for prompts

/**
 * Splits a long document into overlapping chunks.
 * Tries to split at paragraph boundaries.
 * Overlap ensures context isn't lost at chunk edges.
 */
function chunkDocument(content, chunkSize = CHUNK_SIZE, overlap = 500) {
  if (content.length <= chunkSize) return [content];

  const chunks = [];
  let start = 0;

  while (start < content.length) {
    let end = start + chunkSize;

    if (end < content.length) {
      // Try to find a paragraph break near the end
      const breakPoint = content.lastIndexOf("\n\n", end);
      if (breakPoint > start + chunkSize / 2) {
        end = breakPoint;
      }
    }

    chunks.push(content.slice(start, Math.min(end, content.length)));
    start = end - overlap;
  }

  return chunks;
}

// ─── Main fetch function ──────────────────────────────────────────────────────

/**
 * Fetches all input sources and returns normalized documents.
 *
 * @param {string[]} sources - Array of file paths, directory paths, or URLs
 * @returns {Promise<Array<{ source: string, content: string, chunks: string[] }>>}
 */
async function fetchSources(sources) {
  const documents = [];

  for (const source of sources) {
    try {
      // URL
      if (source.startsWith("http://") || source.startsWith("https://")) {
        console.log(`  Fetching URL: ${source}`);
        const content = await fetchUrl(source);
        if (content.trim()) {
          documents.push({
            source,
            content,
            chunks: chunkDocument(content),
          });
          console.log(`    ✓ ${content.length} chars`);
        }
        continue;
      }

      // Directory
      if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
        console.log(`  Reading directory: ${source}`);
        const files = walkDir(source);
        console.log(`    Found ${files.length} files`);
        for (const filePath of files) {
          const content = readFile(filePath);
          if (content.trim()) {
            documents.push({
              source: filePath,
              content,
              chunks: chunkDocument(content),
            });
            console.log(`    ✓ ${path.relative(source, filePath)} (${content.length} chars)`);
          }
        }
        continue;
      }

      // File (possibly comma-separated list)
      const filePaths = source.split(",").map((s) => s.trim()).filter(Boolean);
      for (const filePath of filePaths) {
        if (!fs.existsSync(filePath)) {
          console.warn(`  ⚠ File not found: ${filePath}`);
          continue;
        }
        console.log(`  Reading: ${filePath}`);
        const content = readFile(filePath);
        if (content.trim()) {
          documents.push({
            source: filePath,
            content,
            chunks: chunkDocument(content),
          });
          console.log(`    ✓ ${content.length} chars`);
        }
      }
    } catch (e) {
      console.warn(`  ⚠ Could not read ${source}: ${e.message}`);
    }
  }

  return documents;
}

/**
 * Reads from stdin if input is being piped.
 */
async function fetchStdin() {
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      resolve(data.trim() ? { source: "stdin", content: data, chunks: chunkDocument(data) } : null);
    });
  });
}

/**
 * Combines all documents into a single summary string for domain identification.
 * Truncates if too long — domain ID only needs the first pass.
 */
function summarizeForDomainId(documents, maxChars = 20000) {
  const parts = documents.map((d) => `[${d.source}]\n${d.content}`);
  const full = parts.join("\n\n---\n\n");
  if (full.length <= maxChars) return full;

  // Take proportional excerpts from each document
  const perDoc = Math.floor(maxChars / documents.length);
  return documents
    .map((d) => `[${d.source}]\n${d.content.slice(0, perDoc)}${d.content.length > perDoc ? "\n...(truncated)" : ""}`)
    .join("\n\n---\n\n");
}

module.exports = { fetchSources, fetchStdin, summarizeForDomainId, chunkDocument };
