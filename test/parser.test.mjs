import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import assert from "node:assert/strict";

import {
  parseYaml,
  extractUnitTests,
  extractSchemaTests,
  extractCoverage,
  parseDataTestSQL,
  parseCTEs,
  extractBranches,
  analyzeBranchCoverage,
  extractColumnMeta,
  extractSemanticModels,
  extractMetrics,
  crossReferenceSemanticCoverage,
  parseMetricFlowRef,
  extractSavedQueries,
  parseFile,
} from "../src/parser.mjs";

/* ═══════════════════════════════════════════════
   1. parseYaml
   ═══════════════════════════════════════════════ */
describe("parseYaml", () => {
  it("parses flat key-value pairs", () => {
    const input = `
name: my_model
version: 2
`;
    deepStrictEqual(parseYaml(input), { name: "my_model", version: 2 });
  });

  it("parses nested maps", () => {
    const input = `
config:
  materialized: table
  schema: staging
`;
    deepStrictEqual(parseYaml(input), {
      config: { materialized: "table", schema: "staging" },
    });
  });

  it("parses scalar lists", () => {
    const input = `
tags:
  - nightly
  - important
`;
    deepStrictEqual(parseYaml(input), { tags: ["nightly", "important"] });
  });

  it("parses list of maps (- key: value)", () => {
    const input = `
columns:
  - name: id
    data_type: integer
  - name: email
    data_type: varchar
`;
    deepStrictEqual(parseYaml(input), {
      columns: [
        { name: "id", data_type: "integer" },
        { name: "email", data_type: "varchar" },
      ],
    });
  });

  it("parses inline objects {key: value}", () => {
    const input = `
meta: {no_test: true, reason: "generated column"}
`;
    deepStrictEqual(parseYaml(input), {
      meta: { no_test: true, reason: "generated column" },
    });
  });

  it("parses inline arrays [a, b, c]", () => {
    const input = `
combination_of_columns: [col_a, col_b, col_c]
`;
    deepStrictEqual(parseYaml(input), {
      combination_of_columns: ["col_a", "col_b", "col_c"],
    });
  });

  it("ignores comment lines", () => {
    const input = `
# This is a comment
name: model_a
# Another comment
version: 2
`;
    deepStrictEqual(parseYaml(input), { name: "model_a", version: 2 });
  });

  it("ignores blank lines", () => {
    const input = `

name: model_b

version: 3

`;
    deepStrictEqual(parseYaml(input), { name: "model_b", version: 3 });
  });

  it("handles scalar types: null, true, false, number, string", () => {
    const input = `
a: null
b: true
c: false
d: 42
e: 3.14
f: hello
g: ~
`;
    deepStrictEqual(parseYaml(input), {
      a: null,
      b: true,
      c: false,
      d: 42,
      e: 3.14,
      f: "hello",
      g: null,
    });
  });

  it("returns empty object for empty input", () => {
    deepStrictEqual(parseYaml(""), {});
    deepStrictEqual(parseYaml("   \n\n  "), {});
  });
});

/* ═══════════════════════════════════════════════
   2. extractUnitTests
   ═══════════════════════════════════════════════ */
describe("extractUnitTests", () => {
  it("extracts typical dbt unit_tests with given and expect", () => {
    const parsed = parseYaml(`
unit_tests:
  - name: test_revenue
    model: fct_revenue
    description: Revenue calculation
    given:
      - input: ref('stg_orders')
        rows:
          - {order_id: 1, amount: 100}
          - {order_id: 2, amount: 200}
    expect:
      rows:
        - {order_id: 1, revenue: 100}
        - {order_id: 2, revenue: 200}
`);
    const result = extractUnitTests(parsed);
    strictEqual(result.length, 1);
    strictEqual(result[0].name, "test_revenue");
    strictEqual(result[0].model, "fct_revenue");
    strictEqual(result[0].description, "Revenue calculation");
    strictEqual(result[0].given.length, 1);
    strictEqual(result[0].given[0].input, "ref('stg_orders')");
    strictEqual(result[0].given[0].rows.length, 2);
    strictEqual(result[0].expect.length, 2);
    deepStrictEqual(result[0].expect[0], { order_id: 1, revenue: 100 });
  });

  it("handles fixture references", () => {
    const parsed = parseYaml(`
unit_tests:
  - name: test_with_fixture
    model: my_model
    given:
      - input: ref('stg_source')
        fixture: my_fixture
    expect:
      fixture: expected_fixture
`);
    const result = extractUnitTests(parsed);
    strictEqual(result.length, 1);
    strictEqual(result[0].given[0].fixture, "my_fixture");
    deepStrictEqual(result[0].expect, [{ _fixture: "expected_fixture" }]);
  });

  it("returns empty array for empty unit_tests", () => {
    const parsed = { unit_tests: [] };
    deepStrictEqual(extractUnitTests(parsed), []);
  });

  it("returns empty array when unit_tests key is missing", () => {
    deepStrictEqual(extractUnitTests({}), []);
    deepStrictEqual(extractUnitTests({ models: [] }), []);
  });
});

/* ═══════════════════════════════════════════════
   3. extractSchemaTests
   ═══════════════════════════════════════════════ */
describe("extractSchemaTests", () => {
  it("extracts column-level tests (not_null, unique)", () => {
    const parsed = parseYaml(`
models:
  - name: stg_users
    columns:
      - name: user_id
        tests:
          - not_null
          - unique
      - name: email
        description: User email
        data_type: varchar
        tests:
          - not_null
`);
    const result = extractSchemaTests(parsed);
    strictEqual(result.length, 3);
    strictEqual(result[0].name, "not_null");
    strictEqual(result[0].model, "stg_users");
    strictEqual(result[0].column, "user_id");
    strictEqual(result[1].name, "unique");
    strictEqual(result[2].column, "email");
    strictEqual(result[2].description, "User email");
    strictEqual(result[2].data_type, "varchar");
  });

  it("extracts model-level tests", () => {
    const parsed = parseYaml(`
models:
  - name: fct_orders
    tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - order_id
            - order_date
`);
    const result = extractSchemaTests(parsed);
    strictEqual(result.length, 1);
    strictEqual(result[0].name, "dbt_utils.unique_combination_of_columns");
    strictEqual(result[0].column, "(model-level)");
    deepStrictEqual(result[0].config.combination_of_columns, [
      "order_id",
      "order_date",
    ]);
  });

  it("extracts config from dbt_utils tests", () => {
    const parsed = {
      models: [
        {
          name: "my_model",
          columns: [
            {
              name: "status",
              tests: [
                {
                  accepted_values: {
                    values: ["active", "inactive", "pending"],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = extractSchemaTests(parsed);
    strictEqual(result.length, 1);
    strictEqual(result[0].name, "accepted_values");
    deepStrictEqual(result[0].config.values, ["active", "inactive", "pending"]);
  });

  it("returns empty array when models is empty", () => {
    deepStrictEqual(extractSchemaTests({ models: [] }), []);
    deepStrictEqual(extractSchemaTests({}), []);
  });
});

/* ═══════════════════════════════════════════════
   4. extractCoverage
   ═══════════════════════════════════════════════ */
describe("extractCoverage", () => {
  it("classifies columns into tested / excluded / untested", () => {
    const parsed = {
      models: [
        {
          name: "my_model",
          columns: [
            { name: "id", tests: ["not_null", "unique"] },
            {
              name: "created_at",
              meta: { no_test: true, reason: "auto-generated timestamp" },
            },
            { name: "status" },
          ],
        },
      ],
    };
    const result = extractCoverage(parsed);
    strictEqual(result.length, 1);
    strictEqual(result[0].model, "my_model");
    strictEqual(result[0].tested, 1);
    strictEqual(result[0].excluded, 1);
    strictEqual(result[0].untested, 1);
    strictEqual(result[0].total, 3);

    const idCol = result[0].columns.find((c) => c.name === "id");
    strictEqual(idCol.status, "tested");
    strictEqual(idCol.testCount, 2);

    const createdCol = result[0].columns.find((c) => c.name === "created_at");
    strictEqual(createdCol.status, "excluded");
    strictEqual(createdCol.excludeReason, "auto-generated timestamp");

    const statusCol = result[0].columns.find((c) => c.name === "status");
    strictEqual(statusCol.status, "untested");
  });

  it("calculates coveragePercent correctly", () => {
    const parsed = {
      models: [
        {
          name: "m",
          columns: [
            { name: "a", tests: ["not_null"] },
            { name: "b", meta: { no_test: true } },
            { name: "c" },
            { name: "d", tests: ["unique"] },
          ],
        },
      ],
    };
    const result = extractCoverage(parsed);
    // tested=2, excluded=1, untested=1, total=4 => (2+1)/4 = 75%
    strictEqual(result[0].coveragePercent, 75);
  });

  it("returns empty array when models is missing or empty", () => {
    deepStrictEqual(extractCoverage({}), []);
    deepStrictEqual(extractCoverage({ models: [] }), []);
  });

  it("filters out models with no columns", () => {
    const parsed = {
      models: [{ name: "empty_model", columns: [] }],
    };
    deepStrictEqual(extractCoverage(parsed), []);
  });
});

/* ═══════════════════════════════════════════════
   5. parseDataTestSQL
   ═══════════════════════════════════════════════ */
describe("parseDataTestSQL", () => {
  it("extracts name, description, ref and source", () => {
    const sql = `-- name: check_order_totals
-- description: Verify order totals match line items
SELECT *
FROM {{ ref('fct_orders') }} o
JOIN {{ ref('stg_line_items') }} li ON o.order_id = li.order_id
JOIN {{ source('raw', 'payments') }} p ON o.payment_id = p.id
WHERE o.total != li.sum_amount
`;
    const result = parseDataTestSQL(sql);
    strictEqual(result.type, "data");
    strictEqual(result.name, "check_order_totals");
    strictEqual(result.description, "Verify order totals match line items");
    deepStrictEqual(result.inputs, [
      "fct_orders",
      "stg_line_items",
      "raw.payments",
    ]);
    strictEqual(result.sql, sql);
  });

  it("defaults name to 'Data Test' when no comment present", () => {
    const sql = `SELECT * FROM {{ ref('some_model') }}`;
    const result = parseDataTestSQL(sql);
    strictEqual(result.name, "Data Test");
    strictEqual(result.description, "");
    deepStrictEqual(result.inputs, ["some_model"]);
  });

  it("handles SQL with no refs or sources", () => {
    const sql = `-- name: simple_test\nSELECT 1`;
    const result = parseDataTestSQL(sql);
    strictEqual(result.name, "simple_test");
    deepStrictEqual(result.inputs, []);
  });
});

/* ═══════════════════════════════════════════════
   6. parseCTEs
   ═══════════════════════════════════════════════ */
describe("parseCTEs", () => {
  it("parses WITH clause with multiple CTEs", () => {
    const sql = `
WITH base AS (
  SELECT * FROM {{ ref('stg_orders') }}
),
enriched AS (
  SELECT b.*, c.name
  FROM base b
  JOIN {{ ref('stg_customers') }} c ON b.customer_id = c.id
)
SELECT * FROM enriched
`;
    const result = parseCTEs(sql);
    strictEqual(result.ctes.length, 2);
    strictEqual(result.ctes[0].name, "base");
    deepStrictEqual(result.ctes[0].externalRefs, ["stg_orders"]);
    deepStrictEqual(result.ctes[0].deps, []);

    strictEqual(result.ctes[1].name, "enriched");
    deepStrictEqual(result.ctes[1].externalRefs, ["stg_customers"]);
    deepStrictEqual(result.ctes[1].deps, ["base"]);

    deepStrictEqual(result.finalDeps, ["enriched"]);
  });

  it("handles external refs including source()", () => {
    const sql = `
WITH src AS (
  SELECT * FROM {{ source('raw_db', 'events') }}
)
SELECT * FROM src
`;
    const result = parseCTEs(sql);
    strictEqual(result.ctes.length, 1);
    deepStrictEqual(result.ctes[0].externalRefs, ["raw_db.events"]);
  });

  it("returns empty ctes for SQL without WITH", () => {
    const sql = `SELECT * FROM my_table WHERE id = 1`;
    const result = parseCTEs(sql);
    deepStrictEqual(result.ctes, []);
    strictEqual(result.finalSelect, sql);
  });
});

/* ═══════════════════════════════════════════════
   7. extractBranches
   ═══════════════════════════════════════════════ */
describe("extractBranches", () => {
  it("detects CASE WHEN ... THEN", () => {
    const sql = `
SELECT
  CASE
    WHEN status = 'active' THEN 1
    WHEN status = 'inactive' THEN 0
  END AS is_active
FROM users
`;
    const result = extractBranches(sql);
    const caseWhens = result.filter((b) => b.type === "case_when");
    strictEqual(caseWhens.length, 2);
    strictEqual(caseWhens[0].condition, "status = 'active'");
    strictEqual(caseWhens[1].condition, "status = 'inactive'");
  });

  it("detects ELSE", () => {
    const sql = `
SELECT
  CASE WHEN x > 0 THEN 'pos' ELSE 'non-pos' END
FROM t
`;
    const result = extractBranches(sql);
    const elses = result.filter((b) => b.type === "case_else");
    strictEqual(elses.length, 1);
    strictEqual(elses[0].condition, "ELSE");
  });

  it("detects COALESCE", () => {
    const sql = `SELECT COALESCE(nickname, full_name) FROM users`;
    const result = extractBranches(sql);
    const coalesces = result.filter((b) => b.type === "coalesce");
    strictEqual(coalesces.length, 1);
    strictEqual(coalesces[0].condition, "nickname IS NULL");
  });

  it("detects IIF", () => {
    const sql = `SELECT IIF(age >= 18, 'adult', 'minor') FROM users`;
    const result = extractBranches(sql);
    const iifs = result.filter((b) => b.type === "iif");
    strictEqual(iifs.length, 1);
    strictEqual(iifs[0].condition, "age >= 18");
  });

  it("returns empty array for branchless SQL", () => {
    const sql = `SELECT id, name FROM users WHERE active = true`;
    deepStrictEqual(extractBranches(sql), []);
  });
});

/* ═══════════════════════════════════════════════
   8. extractSemanticModels
   ═══════════════════════════════════════════════ */
describe("extractSemanticModels", () => {
  it("extracts measures, dimensions, and entities", () => {
    const parsed = {
      semantic_models: [
        {
          name: "orders",
          model: "ref('fct_orders')",
          measures: [
            { name: "total_revenue", agg: "sum", expr: "revenue" },
            { name: "order_count", agg: "count" },
          ],
          dimensions: [
            { name: "order_date", type: "time", expr: "created_at" },
            { name: "status", type: "categorical" },
          ],
          entities: [
            { name: "order_id", type: "primary", expr: "id" },
          ],
        },
      ],
    };
    const result = extractSemanticModels(parsed);
    strictEqual(result.length, 1);
    strictEqual(result[0].name, "orders");
    strictEqual(result[0].modelRef, "fct_orders");

    strictEqual(result[0].measures.length, 2);
    strictEqual(result[0].measures[0].name, "total_revenue");
    strictEqual(result[0].measures[0].agg, "sum");
    strictEqual(result[0].measures[0].expr, "revenue");
    // order_count has no explicit expr, falls back to name
    strictEqual(result[0].measures[1].expr, "order_count");

    strictEqual(result[0].dimensions.length, 2);
    strictEqual(result[0].dimensions[0].expr, "created_at");
    strictEqual(result[0].dimensions[1].expr, "status");

    strictEqual(result[0].entities.length, 1);
    strictEqual(result[0].entities[0].expr, "id");
  });

  it("returns empty array when semantic_models is missing", () => {
    deepStrictEqual(extractSemanticModels({}), []);
    deepStrictEqual(extractSemanticModels({ models: [] }), []);
  });

  it("handles Jinja-wrapped model reference", () => {
    const parsed = {
      semantic_models: [
        {
          name: "sm",
          model: "{{ ref('my_model') }}",
          measures: [],
          dimensions: [],
          entities: [],
        },
      ],
    };
    const result = extractSemanticModels(parsed);
    strictEqual(result[0].modelRef, "my_model");
  });
});

/* ═══════════════════════════════════════════════
   9. crossReferenceSemanticCoverage
   ═══════════════════════════════════════════════ */
describe("crossReferenceSemanticCoverage", () => {
  const baseCoverage = [
    {
      model: "fct_orders",
      columns: [
        { name: "id", status: "tested" },
        { name: "revenue", status: "untested" },
        { name: "created_at", status: "excluded" },
      ],
    },
  ];

  it("does not warn for column_not_found (delegated to mf verify-configs)", () => {
    const semanticModels = [
      {
        name: "orders",
        modelRef: "fct_orders",
        measures: [
          { name: "missing_measure", expr: "nonexistent_col", agg: "sum" },
        ],
        dimensions: [],
        entities: [],
      },
    ];
    const warnings = crossReferenceSemanticCoverage(semanticModels, baseCoverage);
    strictEqual(warnings.length, 0);
  });

  it("warns when referenced column has no tests", () => {
    const semanticModels = [
      {
        name: "orders",
        modelRef: "fct_orders",
        measures: [
          { name: "total_revenue", expr: "revenue", agg: "sum" },
        ],
        dimensions: [],
        entities: [],
      },
    ];
    const warnings = crossReferenceSemanticCoverage(semanticModels, baseCoverage);
    strictEqual(warnings.length, 1);
    strictEqual(warnings[0].issue, "no_tests");
    strictEqual(warnings[0].column, "revenue");
  });

  it("does not warn for tested or excluded columns", () => {
    const semanticModels = [
      {
        name: "orders",
        modelRef: "fct_orders",
        measures: [],
        dimensions: [
          { name: "created_at", expr: "created_at", type: "time" },
        ],
        entities: [
          { name: "order_id", expr: "id", type: "primary" },
        ],
      },
    ];
    const warnings = crossReferenceSemanticCoverage(semanticModels, baseCoverage);
    strictEqual(warnings.length, 0);
  });

  it("skips SQL expressions in expr", () => {
    const semanticModels = [
      {
        name: "orders",
        modelRef: "fct_orders",
        measures: [
          { name: "conditional", expr: "case when kind = 'a' then revenue else 0 end", agg: "sum" },
        ],
        dimensions: [],
        entities: [],
      },
    ];
    const warnings = crossReferenceSemanticCoverage(semanticModels, baseCoverage);
    strictEqual(warnings.length, 0);
  });

  it("returns empty warnings when model not found in coverage", () => {
    const semanticModels = [
      {
        name: "unknown",
        modelRef: "nonexistent_model",
        measures: [{ name: "x", expr: "y", agg: "sum" }],
        dimensions: [],
        entities: [],
      },
    ];
    const warnings = crossReferenceSemanticCoverage(semanticModels, baseCoverage);
    strictEqual(warnings.length, 0);
  });
});

/* ═══════════════════════════════════════════════
   10. analyzeBranchCoverage
   ═══════════════════════════════════════════════ */
describe("analyzeBranchCoverage", () => {
  it("returns empty array for empty branches", () => {
    const result = analyzeBranchCoverage([], [{ status: "active" }]);
    assert.deepStrictEqual(result, []);
  });

  it("CASE WHEN col = 'value' with value present in given rows -> possibly covered", () => {
    const branches = [{ type: "case_when", condition: "status = 'active'" }];
    const givenRows = [{ status: "active" }, { status: "inactive" }];
    const result = analyzeBranchCoverage(branches, givenRows);
    assert.equal(result.length, 1);
    assert.equal(result[0].covered, true);
    assert.equal(result[0].coverageNote, "possibly covered");
  });

  it("CASE WHEN col = 'value' with value NOT present in given rows -> value not found", () => {
    const branches = [{ type: "case_when", condition: "status = 'pending'" }];
    const givenRows = [{ status: "active" }, { status: "inactive" }];
    const result = analyzeBranchCoverage(branches, givenRows);
    assert.equal(result.length, 1);
    assert.equal(result[0].covered, false);
    assert.equal(result[0].coverageNote, "value not found in given rows");
  });

  it("IS NULL condition with null present in given rows -> covered", () => {
    const branches = [{ type: "case_when", condition: "status IS NULL" }];
    const givenRows = [{ status: null }, { status: "active" }];
    const result = analyzeBranchCoverage(branches, givenRows);
    assert.equal(result.length, 1);
    assert.equal(result[0].covered, true);
    assert.equal(result[0].coverageNote, "possibly covered");
  });

  it("ELSE branch is always uncovered", () => {
    const branches = [{ type: "case_else", condition: "ELSE" }];
    const givenRows = [{ status: "active" }];
    const result = analyzeBranchCoverage(branches, givenRows);
    assert.equal(result.length, 1);
    assert.equal(result[0].covered, false);
    assert.equal(result[0].coverageNote, "ELSE reachability not analysed");
  });

  it("column not in given rows -> column not in given rows", () => {
    const branches = [{ type: "case_when", condition: "category = 'A'" }];
    const givenRows = [{ status: "active" }];
    const result = analyzeBranchCoverage(branches, givenRows);
    assert.equal(result.length, 1);
    assert.equal(result[0].covered, false);
    assert.equal(result[0].coverageNote, "column not in given rows");
  });
});

/* ═══════════════════════════════════════════════
   11. parseFile
   ═══════════════════════════════════════════════ */
describe("parseFile", () => {
  it("dispatches .sql to parseDataTestSQL", () => {
    const sql = `-- name: test_no_orphans
-- description: No orphan records
SELECT * FROM {{ ref('orders') }} WHERE customer_id IS NULL`;
    const result = parseFile(sql, "tests/test_no_orphans.sql");
    assert.equal(result.tests.length, 1);
    assert.equal(result.tests[0].type, "data");
    assert.equal(result.tests[0].name, "test_no_orphans");
    assert.deepStrictEqual(result.tests[0].inputs, ["orders"]);
  });

  it("dispatches .yml to YAML pipeline (unit + schema + coverage + semanticModels)", () => {
    const yml = `models:
  - name: my_model
    columns:
      - name: id
        data_type: integer
        tests:
          - not_null
          - unique
      - name: name
        description: user name
unit_tests:
  - name: test_basic
    model: my_model
    given:
      - input: ref('source_table')
        rows:
          - {id: 1, name: alice}
    expect:
      rows:
        - {id: 1, name: alice}`;
    const result = parseFile(yml, "models/schema.yml");
    const unitTests = result.tests.filter((t) => t.type === "unit");
    const schemaTests = result.tests.filter((t) => t.type === "schema");
    assert.ok(unitTests.length > 0, "should have unit tests");
    assert.ok(schemaTests.length > 0, "should have schema tests");
    assert.ok(result.coverage.length > 0, "should have coverage data");
    assert.ok(typeof result.columnMeta === "object", "should have columnMeta");
    assert.ok(Array.isArray(result.semanticModels), "should have semanticModels array");
  });

  it("sets sourceFile on all tests", () => {
    const sql = `-- name: check_totals
SELECT 1 FROM {{ ref('fact_sales') }} WHERE total < 0`;
    const result = parseFile(sql, "tests/check_totals.sql");
    for (const t of result.tests) {
      assert.equal(t.sourceFile, "tests/check_totals.sql");
    }

    const yml = `models:
  - name: dim_user
    columns:
      - name: user_id
        tests:
          - not_null`;
    const result2 = parseFile(yml, "models/dim_user.yml");
    for (const t of result2.tests) {
      assert.equal(t.sourceFile, "models/dim_user.yml");
    }
  });
});

/* ═══════════════════════════════════════════════
   12. parseYaml edge cases
   ═══════════════════════════════════════════════ */
describe("parseYaml edge cases", () => {
  it("parses value containing colons", () => {
    const yml = `info:
  description: "time: 10:30"`;
    const result = parseYaml(yml);
    assert.equal(result.info.description, "time: 10:30");
  });

  it("data_tests key works the same as tests in extractSchemaTests", () => {
    const yml = `models:
  - name: my_model
    columns:
      - name: id
        data_tests:
          - not_null
          - unique`;
    const parsed = parseYaml(yml);
    const tests = extractSchemaTests(parsed);
    assert.equal(tests.length, 2);
    assert.equal(tests[0].name, "not_null");
    assert.equal(tests[1].name, "unique");
  });

  it("data_tests key works for model-level tests", () => {
    const yml = `models:
  - name: my_model
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - col_a
            - col_b`;
    const parsed = parseYaml(yml);
    const tests = extractSchemaTests(parsed);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].name, "dbt_utils.unique_combination_of_columns");
    assert.equal(tests[0].column, "(model-level)");
  });
});

/* ═══════════════════════════════════════════════
   13. extractColumnMeta
   ═══════════════════════════════════════════════ */
describe("extractColumnMeta", () => {
  it("extracts description and data_type from model columns", () => {
    const parsed = {
      models: [
        {
          name: "dim_user",
          columns: [
            { name: "user_id", description: "Primary key", data_type: "integer" },
            { name: "email", description: "User email" },
          ],
        },
      ],
    };
    const meta = extractColumnMeta(parsed);
    assert.deepStrictEqual(meta.dim_user.user_id, {
      description: "Primary key",
      data_type: "integer",
    });
    assert.deepStrictEqual(meta.dim_user.email, {
      description: "User email",
      data_type: null,
    });
  });

  it("returns empty object when models is missing", () => {
    assert.deepStrictEqual(extractColumnMeta({}), {});
  });

  it("returns empty object when models is not an array", () => {
    assert.deepStrictEqual(extractColumnMeta({ models: "not_array" }), {});
  });
});

/* ═══════════════════════════════════════════════
   parseYaml depth limit
   ═══════════════════════════════════════════════ */
describe("parseYaml depth limit", () => {
  it("handles deeply nested YAML (60 levels) without stack overflow", () => {
    // Build YAML with 60 levels of nesting (exceeds MAX_DEPTH of 50)
    let yaml = "";
    for (let i = 0; i < 60; i++) {
      yaml += " ".repeat(i * 2) + `level${i}:\n`;
    }
    yaml += " ".repeat(60 * 2) + "value: deep";
    // Should not throw - gracefully truncates at depth limit
    const result = parseYaml(yaml);
    assert.ok(result, "should return a result without throwing");
    assert.strictEqual(result.level0.level1.level2 !== undefined, true, "shallow levels should parse");
  });

  it("parses normal depth YAML correctly", () => {
    const yaml = `
a:
  b:
    c:
      d: value
`;
    const result = parseYaml(yaml);
    assert.deepStrictEqual(result, { a: { b: { c: { d: "value" } } } });
  });
});

/* ═══════════════════════════════════════════════
   extractMetrics
   ═══════════════════════════════════════════════ */
describe("extractMetrics", () => {
  it("extracts simple metric with string measure", () => {
    const parsed = {
      metrics: [
        {
          name: "total_revenue",
          type: "simple",
          type_params: { measure: "revenue" },
        },
      ],
    };
    const result = extractMetrics(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "total_revenue");
    assert.equal(result[0].type, "simple");
    assert.equal(result[0].measure, "revenue");
    assert.equal(result[0].measureFilter, null);
  });

  it("extracts metric with object measure (name + filter)", () => {
    const parsed = {
      metrics: [
        {
          name: "filtered_revenue",
          type: "simple",
          type_params: {
            measure: { name: "revenue", filter: "{{ Dimension('order__is_valid') }} = true" },
          },
        },
      ],
    };
    const result = extractMetrics(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].measure, "revenue");
    assert.equal(result[0].measureFilter, "{{ Dimension('order__is_valid') }} = true");
  });

  it("extracts derived metric with expr and metrics list", () => {
    const parsed = {
      metrics: [
        {
          name: "revenue_per_order",
          type: "derived",
          type_params: {
            expr: "a / b",
            metrics: [{ name: "a" }, { name: "b" }],
          },
        },
      ],
    };
    const result = extractMetrics(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "derived");
    assert.equal(result[0].expr, "a / b");
    assert.deepStrictEqual(result[0].metrics, ["a", "b"]);
    assert.equal(result[0].measure, null);
  });

  it("captures extra type_params (e.g. window) in typeParams", () => {
    const parsed = {
      metrics: [
        {
          name: "rolling_revenue",
          type: "simple",
          type_params: { measure: "x", window: 7 },
        },
      ],
    };
    const result = extractMetrics(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].measure, "x");
    assert.deepStrictEqual(result[0].typeParams, { window: 7 });
  });

  it("returns empty array when metrics key is missing", () => {
    assert.deepStrictEqual(extractMetrics({}), []);
    assert.deepStrictEqual(extractMetrics({ models: [] }), []);
  });

  it("resolves semanticModel from same parsed YAML", () => {
    const parsed = {
      semantic_models: [{ name: "orders" }],
      metrics: [
        {
          name: "order_count",
          type: "simple",
          type_params: { measure: "count_orders" },
        },
      ],
    };
    const result = extractMetrics(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].semanticModel, "orders");
  });

  it("sets semanticModel to null when semantic_models is absent", () => {
    const parsed = {
      metrics: [
        {
          name: "standalone_metric",
          type: "simple",
          type_params: { measure: "some_measure" },
        },
      ],
    };
    const result = extractMetrics(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].semanticModel, null);
  });

  it("extracts metric-level filter", () => {
    const parsed = {
      metrics: [
        {
          name: "active_revenue",
          type: "simple",
          type_params: { measure: "revenue" },
          filter: "{{ Dimension('x') }} = true",
        },
      ],
    };
    const result = extractMetrics(parsed);
    assert.equal(result.length, 1);
    assert.equal(result[0].filter, "{{ Dimension('x') }} = true");
  });
});

/* ═══════════════════════════════════════════════
   parseMetricFlowRef
   ═══════════════════════════════════════════════ */
describe("parseMetricFlowRef", () => {
  it("parses Entity reference", () => {
    const result = parseMetricFlowRef("Entity('club')");
    assert.deepStrictEqual(result, { type: "entity", name: "club" });
  });

  it("parses Dimension reference", () => {
    const result = parseMetricFlowRef("Dimension('club__club_nm_short')");
    assert.deepStrictEqual(result, { type: "dimension", name: "club__club_nm_short" });
  });

  it("parses TimeDimension with grain", () => {
    const result = parseMetricFlowRef("TimeDimension('league_standing__snapshot_date', 'day')");
    assert.deepStrictEqual(result, { type: "time_dimension", name: "league_standing__snapshot_date", grain: "day" });
  });

  it("parses Metric reference", () => {
    const result = parseMetricFlowRef("Metric('current_point')");
    assert.deepStrictEqual(result, { type: "metric", name: "current_point" });
  });

  it("ignores method chains like .descending(True)", () => {
    const result = parseMetricFlowRef("Metric('current_point').descending(True)");
    assert.deepStrictEqual(result, { type: "metric", name: "current_point" });
  });

  it("handles double quotes", () => {
    const result = parseMetricFlowRef('Entity("club")');
    assert.deepStrictEqual(result, { type: "entity", name: "club" });
  });

  it("returns null for invalid input", () => {
    assert.strictEqual(parseMetricFlowRef("invalid"), null);
    assert.strictEqual(parseMetricFlowRef(""), null);
  });

  it("returns null for non-string input", () => {
    assert.strictEqual(parseMetricFlowRef(null), null);
    assert.strictEqual(parseMetricFlowRef(undefined), null);
    assert.strictEqual(parseMetricFlowRef(42), null);
  });
});

/* ═══════════════════════════════════════════════
   extractSavedQueries
   ═══════════════════════════════════════════════ */
describe("extractSavedQueries", () => {
  it("extracts saved query with full query_params", () => {
    const parsed = {
      saved_queries: [{
        name: "latest_league_standings",
        description: "Latest league standings",
        label: "Latest Standings",
        query_params: {
          metrics: ["current_point", "best_ranking"],
          group_by: [
            "Entity('club')",
            "Dimension('club__club_nm_short')",
            "TimeDimension('league_standing__snapshot_date', 'day')",
          ],
          where: ["{{ TimeDimension('league_standing__snapshot_date', 'day') }} = current_date()"],
          order_by: ["Metric('current_point').descending(True)"],
          limit: 20,
        },
      }],
    };
    const result = extractSavedQueries(parsed);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "latest_league_standings");
    assert.strictEqual(result[0].description, "Latest league standings");
    assert.strictEqual(result[0].label, "Latest Standings");
    assert.deepStrictEqual(result[0].metrics, ["current_point", "best_ranking"]);

    // groupByParsed
    assert.strictEqual(result[0].groupByParsed.entities.length, 1);
    assert.strictEqual(result[0].groupByParsed.entities[0], "club");
    assert.strictEqual(result[0].groupByParsed.dimensions.length, 1);
    assert.strictEqual(result[0].groupByParsed.dimensions[0], "club__club_nm_short");
    assert.strictEqual(result[0].groupByParsed.timeDimensions.length, 1);
    assert.strictEqual(result[0].groupByParsed.timeDimensions[0], "league_standing__snapshot_date");

    assert.deepStrictEqual(result[0].where, [
      "{{ TimeDimension('league_standing__snapshot_date', 'day') }} = current_date()",
    ]);
    assert.deepStrictEqual(result[0].orderBy, ["Metric('current_point').descending(True)"]);
    assert.strictEqual(result[0].limit, 20);
  });

  it("returns empty array when saved_queries is missing", () => {
    assert.deepStrictEqual(extractSavedQueries({}), []);
    assert.deepStrictEqual(extractSavedQueries({ models: [] }), []);
  });

  it("handles saved query without optional fields", () => {
    const parsed = {
      saved_queries: [{
        name: "simple_query",
        query_params: {
          metrics: ["total_revenue"],
          group_by: ["Dimension('product__category')"],
        },
      }],
    };
    const result = extractSavedQueries(parsed);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "simple_query");
    assert.strictEqual(result[0].description, "");
    assert.strictEqual(result[0].label, "");
    assert.deepStrictEqual(result[0].where, []);
    assert.deepStrictEqual(result[0].orderBy, []);
    assert.strictEqual(result[0].limit, null);
  });

  it("filters out null entries", () => {
    const parsed = {
      saved_queries: [
        null,
        { name: "valid", query_params: { metrics: ["m1"], group_by: [] } },
        null,
      ],
    };
    const result = extractSavedQueries(parsed);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "valid");
  });

  it("handles saved query without query_params", () => {
    const parsed = {
      saved_queries: [{ name: "no_params" }],
    };
    const result = extractSavedQueries(parsed);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "no_params");
    assert.deepStrictEqual(result[0].metrics, []);
    assert.deepStrictEqual(result[0].groupBy, []);
    assert.deepStrictEqual(result[0].groupByParsed, {
      entities: [],
      dimensions: [],
      timeDimensions: [],
    });
  });

  it("defaults name to '?' when name is missing", () => {
    const parsed = {
      saved_queries: [{ query_params: { metrics: ["m1"], group_by: [] } }],
    };
    const result = extractSavedQueries(parsed);
    assert.strictEqual(result[0].name, "?");
  });
});
