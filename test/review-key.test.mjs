import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadReviewKeySandbox() {
  const html = readFileSync(new URL("../src/template.html", import.meta.url), "utf-8");
  const reviewKeyBlock = html.match(/function reviewKey\(t\) \{[\s\S]*?\n\}/);
  const persistenceBlock = html.match(/\/\/ --- Review persistence ---([\s\S]*?)\/\/ --- CTE DAG Graph ---/);
  assert.ok(reviewKeyBlock, "reviewKey function not found");
  assert.ok(persistenceBlock, "Review persistence block not found");

  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(persistenceBlock[1] + "\n" + reviewKeyBlock[0], sandbox);
  return sandbox;
}

describe("reviewKey", () => {
  it("distinguishes same-name model-level tests by config", () => {
    const { reviewKey } = loadReviewKeySandbox();

    const first = reviewKey({
      type: "schema",
      name: "dbt_utils.expression_is_true",
      model: "fct_orders",
      column: "(model-level)",
      config: { expression: "gross_amount >= 0" },
    });
    const second = reviewKey({
      type: "schema",
      name: "dbt_utils.expression_is_true",
      model: "fct_orders",
      column: "(model-level)",
      config: { expression: "net_amount >= 0" },
    });

    assert.notEqual(first, second);
  });

  it("keeps column-level schema tests grouped by model and column", () => {
    const { reviewKey } = loadReviewKeySandbox();

    const notNull = reviewKey({
      type: "schema",
      name: "not_null",
      model: "fct_orders",
      column: "order_id",
    });
    const unique = reviewKey({
      type: "schema",
      name: "unique",
      model: "fct_orders",
      column: "order_id",
    });

    assert.equal(notNull, unique);
  });
});
