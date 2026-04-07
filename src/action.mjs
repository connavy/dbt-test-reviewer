#!/usr/bin/env node
// src/action.mjs — GitHub Actions script
// Posts a test review comment on PRs

import { parseFile, parseCTEs, testsToMarkdown, crossReferenceSemanticCoverage } from "./parser.mjs";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // "owner/repo"
const PR_NUMBER = process.env.PR_NUMBER;
const COMMENT_TAG = "<!-- dbt-test-reviewer -->";

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER) {
  console.error("Missing env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER");
  process.exit(1);
}

const [owner, repo] = GITHUB_REPOSITORY.split("/");

async function ghFetch(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  console.log(`Fetching PR #${PR_NUMBER} files from ${owner}/${repo}...`);

  // Get PR info
  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${PR_NUMBER}`);
  const headSha = pr.head.sha;

  // Get changed files (paginated)
  let files = [];
  let page = 1;
  while (true) {
    const batch = await ghFetch(`/repos/${owner}/${repo}/pulls/${PR_NUMBER}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  const testFiles = files.filter(
    (f) => /\.(yml|yaml|sql)$/i.test(f.filename) && f.status !== "removed"
  );

  if (!testFiles.length) {
    console.log("No YAML/SQL files changed in this PR. Skipping.");
    process.exit(0);
  }

  console.log(`Found ${testFiles.length} YAML/SQL files`);

  // Fetch content and parse
  const allTests = [];
  const cteResults = {};
  const allCoverage = [];
  const allSemanticModels = [];

  let skipCount = 0;
  for (const f of testFiles) {
    try {
      const data = await ghFetch(
        `/repos/${owner}/${repo}/contents/${f.filename}?ref=${headSha}`
      );
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      const { tests, coverage, semanticModels } = parseFile(content, f.filename);
      allTests.push(...tests);
      allCoverage.push(...coverage);
      allSemanticModels.push(...semanticModels);

      // Check for CTEs in SQL files
      if (f.filename.endsWith(".sql")) {
        const cte = parseCTEs(content);
        if (cte.ctes.length) cteResults[f.filename] = cte;
      }
    } catch (e) {
      skipCount++;
      console.warn(`Warning: skipped ${f.filename}: ${e.message}`);
    }
  }

  if (skipCount === testFiles.length && testFiles.length > 0) {
    console.error(`ERROR: All ${testFiles.length} files failed to process.`);
    process.exit(1);
  }

  if (!allTests.length) {
    console.log("No tests found in changed files. Skipping.");
    process.exit(0);
  }

  console.log(`Parsed ${allTests.length} tests`);

  // Generate Markdown
  const semanticWarnings = crossReferenceSemanticCoverage(allSemanticModels, allCoverage);
  const md =
    COMMENT_TAG +
    "\n" +
    testsToMarkdown(allTests, {
      title: "🧪 dbt Test Review",
      prNum: PR_NUMBER,
      cteResults: Object.keys(cteResults).length ? cteResults : undefined,
      coverageData: allCoverage.length ? allCoverage : undefined,
      semanticWarnings: semanticWarnings.length ? semanticWarnings : undefined,
    });

  // Find existing comment to update (upsert)
  let comments = [];
  let cPage = 1;
  while (true) {
    const batch = await ghFetch(
      `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments?per_page=100&page=${cPage}`
    );
    comments.push(...batch);
    if (batch.length < 100) break;
    cPage++;
  }
  const existing = comments.find((c) => c.body?.includes(COMMENT_TAG));

  if (existing) {
    console.log(`Updating existing comment #${existing.id}`);
    await ghFetch(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: md }),
    });
  } else {
    console.log("Creating new comment");
    await ghFetch(`/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: md }),
    });
  }

  console.log("Done! Review comment posted.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
