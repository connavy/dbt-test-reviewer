import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadReviewPersistenceSandbox() {
  const html = readFileSync(new URL("../src/template.html", import.meta.url), "utf-8");
  const block = html.match(/\/\/ --- Review persistence ---([\s\S]*?)\/\/ --- CTE DAG Graph ---/);
  assert.ok(block, "Review persistence block not found");

  const storage = new Map();
  const sandbox = {
    console,
    location: { pathname: "/dbt-review.html" },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    DATA: {
      context: { dir: "/workspace/dbt-project", gitBranch: "feature/save-reviews" },
      allTests: [
        { type: "unit", name: "test_revenue", model: "fct_revenue" },
      ],
      coverageData: [
        {
          model: "fct_revenue",
          columns: [
            { name: "untested_col", status: "untested" },
            { name: "excluded_col", status: "excluded" },
            { name: "tested_col", status: "tested" },
          ],
        },
      ],
      semanticModels: [
        { name: "orders_semantic", modelRef: "fct_revenue" },
      ],
    },
    reviews: {},
    comments: {},
    reviewKey(t) {
      if (t.type === "schema" && t.column !== "(model-level)") return "col:" + t.model + ":" + t.column;
      return t.type + ":" + t.name + ":" + (t.model || "");
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(block[1], sandbox);
  sandbox.storage = storage;
  return sandbox;
}

describe("review state persistence", () => {
  it("scopes the storage key to project context and branch", () => {
    const sandbox = loadReviewPersistenceSandbox();

    const key = sandbox.getReviewStorageKey(sandbox.DATA);
    const otherBranchKey = sandbox.getReviewStorageKey({
      ...sandbox.DATA,
      context: { ...sandbox.DATA.context, gitBranch: "other-branch" },
    });

    assert.match(key, /^dbt-reviewer-review-state:v1:/);
    assert.notEqual(otherBranchKey, key);
  });

  it("loads only review items that exist in the current data", () => {
    const sandbox = loadReviewPersistenceSandbox();
    const key = sandbox.getReviewStorageKey(sandbox.DATA);
    sandbox.localStorage.setItem(key, JSON.stringify({
      version: 1,
      reviews: {
        "unit:test_revenue:fct_revenue": "approved",
        "col:fct_revenue:untested_col": "needs_change",
        "semantic:orders_semantic:fct_revenue": "approved",
        "unit:removed_test:fct_revenue": "needs_change",
        "col:fct_revenue:tested_col": "approved",
      },
      comments: {
        "unit:test_revenue:fct_revenue": "looks good",
        "unit:removed_test:fct_revenue": "stale comment",
      },
    }));

    assert.equal(sandbox.loadReviewState(sandbox.DATA), true);

    assert.deepEqual(sandbox.reviews, {
      "unit:test_revenue:fct_revenue": "approved",
      "col:fct_revenue:untested_col": "needs_change",
      "semantic:orders_semantic:fct_revenue": "approved",
    });
    assert.deepEqual(sandbox.comments, {
      "unit:test_revenue:fct_revenue": "looks good",
    });
  });

  it("saves only non-empty review state for current items", () => {
    const sandbox = loadReviewPersistenceSandbox();
    sandbox.reviews["unit:test_revenue:fct_revenue"] = "approved";
    sandbox.reviews["col:fct_revenue:untested_col"] = "pending";
    sandbox.reviews["unit:removed_test:fct_revenue"] = "needs_change";
    sandbox.comments["col:fct_revenue:untested_col"] = "please add accepted risk";
    sandbox.comments["semantic:orders_semantic:fct_revenue"] = "";

    assert.equal(sandbox.saveReviewState(), true);

    const saved = JSON.parse(sandbox.storage.get(sandbox.getReviewStorageKey(sandbox.DATA)));
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.reviews, {
      "unit:test_revenue:fct_revenue": "approved",
    });
    assert.deepEqual(saved.comments, {
      "col:fct_revenue:untested_col": "please add accepted risk",
    });
    assert.ok(saved.savedAt);
  });
});
