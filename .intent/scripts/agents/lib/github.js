"use strict";

/**
 * github.js
 *
 * Thin wrapper around the GitHub REST API.
 * Uses the GITHUB_TOKEN provided by Actions — no extra auth needed.
 *
 * All methods are async and throw on non-2xx responses.
 */

const https = require("https");

const BASE = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN;
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || "/").split("/");

if (!TOKEN) {
  console.warn("Warning: GITHUB_TOKEN not set — GitHub API calls will fail");
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "intent-harness-spec-agent/0.1",
        ...(data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {}),
      },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(
            new Error(
              `GitHub API ${method} ${path} → ${res.statusCode}: ${raw.slice(0, 200)}`
            )
          );
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve(raw);
        }
      });
    });

    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Issues ──────────────────────────────────────────────────────────────────

async function getIssue(number) {
  return request("GET", `/repos/${OWNER}/${REPO}/issues/${number}`);
}

async function getIssueComments(number) {
  return request(
    "GET",
    `/repos/${OWNER}/${REPO}/issues/${number}/comments?per_page=100`
  );
}

async function createIssueComment(number, body) {
  return request("POST", `/repos/${OWNER}/${REPO}/issues/${number}/comments`, {
    body,
  });
}

async function createIssue(title, body, labels = []) {
  return request("POST", `/repos/${OWNER}/${REPO}/issues`, {
    title,
    body,
    labels,
  });
}

async function addLabels(number, labels) {
  return request(
    "POST",
    `/repos/${OWNER}/${REPO}/issues/${number}/labels`,
    { labels }
  );
}

// ─── Pull requests ────────────────────────────────────────────────────────────

async function getPR(number) {
  return request("GET", `/repos/${OWNER}/${REPO}/pulls/${number}`);
}

async function getPRComments(number) {
  return request(
    "GET",
    `/repos/${OWNER}/${REPO}/issues/${number}/comments?per_page=100`
  );
}

async function createPR(title, body, head, base = "main") {
  return request("POST", `/repos/${OWNER}/${REPO}/pulls`, {
    title,
    body,
    head,
    base,
  });
}

// ─── Git / file operations ────────────────────────────────────────────────────

async function getRef(ref) {
  return request(
    "GET",
    `/repos/${OWNER}/${REPO}/git/ref/heads/${ref}`
  );
}

async function getDefaultBranch() {
  const repo = await request("GET", `/repos/${OWNER}/${REPO}`);
  return repo.default_branch || "main";
}

async function createBranch(branchName, fromSha) {
  return request("POST", `/repos/${OWNER}/${REPO}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  });
}

async function getFileSha(filePath, branch) {
  try {
    const result = await request(
      "GET",
      `/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${branch}`
    );
    return result.sha;
  } catch {
    return null; // file doesn't exist yet
  }
}

async function upsertFile(filePath, content, message, branch) {
  const existingSha = await getFileSha(filePath, branch);
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (existingSha) body.sha = existingSha;

  return request(
    "PUT",
    `/repos/${OWNER}/${REPO}/contents/${filePath}`,
    body
  );
}

/**
 * Commits multiple files to a branch in a single operation
 * by using the Git Trees API. More efficient than sequential upserts
 * and produces a single clean commit.
 */
async function commitFiles(files, message, branch) {
  // Get current branch tip
  const refData = await request(
    "GET",
    `/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`
  );
  const baseSha = refData.object.sha;

  // Get base tree SHA
  const baseCommit = await request(
    "GET",
    `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`
  );
  const baseTreeSha = baseCommit.tree.sha;

  // Create blobs for each file
  const treeItems = await Promise.all(
    files.map(async ({ path: filePath, content }) => {
      const blob = await request(
        "POST",
        `/repos/${OWNER}/${REPO}/git/blobs`,
        {
          content: Buffer.from(content).toString("base64"),
          encoding: "base64",
        }
      );
      return {
        path: filePath,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      };
    })
  );

  // Create tree
  const tree = await request("POST", `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  // Create commit
  const commit = await request(
    "POST",
    `/repos/${OWNER}/${REPO}/git/commits`,
    {
      message,
      tree: tree.sha,
      parents: [baseSha],
    }
  );

  // Update branch ref
  await request(
    "PATCH",
    `/repos/${OWNER}/${REPO}/git/refs/heads/${branch}`,
    {
      sha: commit.sha,
    }
  );

  return commit;
}

// ─── Repo contents ────────────────────────────────────────────────────────────

async function getFileContents(filePath, branch = "main") {
  try {
    const result = await request(
      "GET",
      `/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${branch}`
    );
    return Buffer.from(result.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function listFiles(dirPath, branch = "main") {
  try {
    const result = await request(
      "GET",
      `/repos/${OWNER}/${REPO}/contents/${dirPath}?ref=${branch}`
    );
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

module.exports = {
  getIssue,
  getIssueComments,
  createIssueComment,
  createIssue,
  addLabels,
  getPR,
  getPRComments,
  createPR,
  getRef,
  getDefaultBranch,
  createBranch,
  getFileSha,
  upsertFile,
  commitFiles,
  getFileContents,
  listFiles,
  OWNER,
  REPO,
};
