"use strict";

/**
 * figma.js
 *
 * Fetches frame metadata from a Figma URL using the Figma REST API.
 * Requires FIGMA_ACCESS_TOKEN in environment.
 *
 * We only fetch metadata — file name, frame name, last modified.
 * We never fetch the visual content.
 *
 * If the token is missing or the fetch fails, returns null gracefully.
 * The spec agent handles null by asking the designer directly.
 */

const https = require("https");

const FIGMA_TOKEN = process.env.FIGMA_ACCESS_TOKEN;

/**
 * Parses a Figma URL into its component parts.
 *
 * Handles these formats:
 *   https://www.figma.com/file/{fileKey}/{title}?node-id={nodeId}
 *   https://www.figma.com/design/{fileKey}/{title}?node-id={nodeId}
 */
function parseFigmaUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);

    // parts[0] = "file" or "design", parts[1] = fileKey
    const fileKey = parts[1];
    const nodeId = parsed.searchParams.get("node-id")?.replace(/-/g, ":");

    if (!fileKey) return null;
    return { fileKey, nodeId };
  } catch {
    return null;
  }
}

function figmaRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.figma.com",
      path,
      method: "GET",
      headers: {
        "X-Figma-Token": FIGMA_TOKEN,
      },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Figma API ${path} → ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Figma API returned non-JSON"));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * Finds a node in the Figma document tree by ID.
 */
function findNode(node, targetId) {
  if (!node) return null;
  const normalizedId = targetId.replace(/-/g, ":").replace(/%3A/g, ":");
  const normalizedNode = (node.id || "").replace(/-/g, ":").replace(/%3A/g, ":");
  if (normalizedNode === normalizedId) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNode(child, targetId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Fetches metadata for a Figma URL.
 *
 * Returns:
 *   {
 *     fileKey,
 *     fileName,       // Figma file name
 *     frameName,      // Frame/node name if node-id present
 *     lastModified,   // ISO date string
 *     url             // the original URL
 *   }
 *
 * Returns null if the fetch fails or token is missing.
 */
async function fetchFigmaMetadata(url) {
  if (!FIGMA_TOKEN) {
    console.warn("FIGMA_ACCESS_TOKEN not set — skipping Figma metadata fetch");
    return null;
  }

  const parsed = parseFigmaUrl(url);
  if (!parsed) return null;

  try {
    // Fetch file metadata (lightweight — just the file info, not full document)
    const fileData = await figmaRequest(`/v1/files/${parsed.fileKey}?depth=1`);

    const result = {
      fileKey: parsed.fileKey,
      fileName: fileData.name,
      lastModified: fileData.lastModified,
      url,
    };

    // If we have a node ID, try to get the frame name
    if (parsed.nodeId) {
      try {
        const nodeData = await figmaRequest(
          `/v1/files/${parsed.fileKey}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`
        );
        const node = nodeData.nodes?.[parsed.nodeId]?.document;
        if (node?.name) {
          result.frameName = node.name;
        }
      } catch {
        // Node fetch failed — not fatal, we still have file metadata
      }
    }

    return result;
  } catch (e) {
    console.warn(`Figma metadata fetch failed: ${e.message}`);
    return null;
  }
}

/**
 * Detects Figma URLs in a text string.
 * Returns all matches.
 */
function extractFigmaUrls(text) {
  const pattern = /https:\/\/www\.figma\.com\/(file|design)\/[A-Za-z0-9]+[^\s)"]*/g;
  return [...(text.match(pattern) || [])];
}

module.exports = { fetchFigmaMetadata, extractFigmaUrls, parseFigmaUrl };
