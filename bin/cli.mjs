#!/usr/bin/env node
// bin/cli.mjs — dbt-test-reviewer CLI

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, watch } from "fs";
import { join, extname, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { parseFile, parseCTEs, testsToMarkdown, extractCoverage, extractColumnMeta, extractModelDescriptions, crossReferenceSemanticCoverage, extractBranches, analyzeBranchCoverage } from "../src/parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RESET = "\x1b[0m", BOLD = "\x1b[1m", DIM = "\x1b[2m";
const GREEN = "\x1b[32m", BLUE = "\x1b[34m", PURPLE = "\x1b[35m";
const CYAN = "\x1b[36m", YELLOW = "\x1b[33m", RED = "\x1b[31m", GRAY = "\x1b[90m";

function log(m) { console.log(m); }
function heading(m) { log(`\n${BOLD}${CYAN}${m}${RESET}`); }
function warn(m) { log(`${YELLOW}⚠${RESET} ${m}`); }
function error(m) { log(`${RED}✗${RESET} ${m}`); }

/* ═══════════════════════════════════════════════ */
function findTestFiles(dir, patterns = []) {
  const files = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || ["node_modules", "target", "dbt_packages"].includes(e.name)) continue;
      const fp = join(dir, e.name);
      if (e.isDirectory()) files.push(...findTestFiles(fp, patterns));
      else {
        const ext = extname(e.name).toLowerCase();
        if ([".yml", ".yaml", ".sql"].includes(ext)) {
          if (!patterns.length || patterns.some(p => fp.includes(p))) files.push(fp);
        }
      }
    }
  } catch (e) { process.stderr.write(`Warning: cannot read ${dir}: ${e.message}\n`); }
  return files;
}

function loadAll(dir, patterns) {
  const files = findTestFiles(dir, patterns);
  const allTests = [], cteResults = {}, allCoverage = [], allColumnMeta = {}, allSemanticModels = [], allMetrics = [], allModelDescriptions = {};
  const sqlByModel = {}; // model name -> SQL content for branch analysis
  const fileContents = {}; // filename -> raw content
  for (const f of files) {
    try {
      const content = readFileSync(f, "utf-8");
      const rel = f.replace(dir + "/", "");
      fileContents[rel] = content;
      const { tests, coverage, columnMeta, semanticModels, metrics, modelDescriptions } = parseFile(content, rel);
      allTests.push(...tests);
      allCoverage.push(...coverage);
      Object.assign(allColumnMeta, columnMeta);
      Object.assign(allModelDescriptions, modelDescriptions || {});
      allSemanticModels.push(...semanticModels);
      allMetrics.push(...(metrics || []));
      if (extname(f).toLowerCase() === ".sql") {
        const cte = parseCTEs(content);
        if (cte.ctes.length) cteResults[rel] = cte;
        // Map model name (filename without ext) -> SQL for branch analysis
        const modelName = rel.split("/").pop().replace(/\.sql$/i, "");
        sqlByModel[modelName] = content;
      }
    } catch (e) { process.stderr.write(`Skip ${f}: ${e.message}\n`); }
  }
  // Branch analysis: attach to unit tests
  for (const t of allTests) {
    if (t.type === "unit" && t.model && sqlByModel[t.model]) {
      const branches = extractBranches(sqlByModel[t.model]);
      const allGivenRows = t.given.flatMap(g => g.rows || []);
      t.branchAnalysis = analyzeBranchCoverage(branches, allGivenRows);
    }
  }
  const semanticWarnings = crossReferenceSemanticCoverage(allSemanticModels, allCoverage);
  return { allTests, cteResults, coverageData: allCoverage, columnMeta: allColumnMeta, modelDescriptions: allModelDescriptions, semanticModels: allSemanticModels, metrics: allMetrics, semanticWarnings, fileContents, fileCount: files.length };
}

/* ═══════════════════════════════════════════════
   Terminal preview
   ═══════════════════════════════════════════════ */
function printTable(rows, color = BLUE) {
  if (!rows?.length) { log(`  ${DIM}(no data)${RESET}`); return; }
  const cols = [...new Set(rows.flatMap(r => r && typeof r === "object" ? Object.keys(r) : []))];
  if (!cols.length) return;
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r?.[c] ?? "null").length)));
  const pad = (s, w) => String(s).padEnd(w);
  log(`  ${GRAY}${cols.map((c, i) => pad(c, widths[i])).join("  ")}${RESET}`);
  log(`  ${GRAY}${widths.map(w => "─".repeat(w)).join("──")}${RESET}`);
  for (const row of rows) {
    const cells = cols.map((c, i) => {
      const v = row?.[c];
      if (v == null) return `${DIM}${pad("null", widths[i])}${RESET}`;
      if (v === true) return `${GREEN}${pad("true", widths[i])}${RESET}`;
      if (v === false) return `${RED}${pad("false", widths[i])}${RESET}`;
      if (typeof v === "number") return `${YELLOW}${pad(v, widths[i])}${RESET}`;
      return `${color}${pad(v, widths[i])}${RESET}`;
    });
    log(`  ${cells.join("  ")}`);
  }
}

function printTests(tests, { verbose = false } = {}) {
  const counts = { unit: 0, schema: 0, data: 0 };
  tests.forEach(t => counts[t.type]++);
  heading(`${tests.length} tests found`);
  log(`  Unit: ${counts.unit}  Schema: ${counts.schema}  Data: ${counts.data}\n`);
  for (const t of tests) {
    if (t.type === "unit") {
      log(`${GREEN}${BOLD}  UNIT${RESET}  ${BOLD}${t.name}${RESET} → ${t.model}  ${DIM}${t.sourceFile || ""}${RESET}`);
      if (t.description) log(`  ${DIM}${t.description}${RESET}`);
      log("");
      for (const g of t.given) { log(`  ${BLUE}↓ INPUT: ${g.input}${RESET} ${DIM}(${g.rows.length} rows)${RESET}`); printTable(g.rows); log(""); }
      log(`  ${GREEN}↑ EXPECTED OUTPUT${RESET} ${DIM}(${t.expect.length} rows)${RESET}`);
      printTable(t.expect, GREEN); log("");
    } else if (t.type === "schema") {
      const cfg = t.config && Object.keys(t.config).length ? `  ${YELLOW}${JSON.stringify(t.config)}${RESET}` : "";
      log(`${PURPLE}${BOLD}  SCHEMA${RESET}  ${BOLD}${t.name}${RESET}  ${DIM}${t.model}.${t.column}${RESET}${cfg}`);
    } else if (t.type === "data") {
      log(`${YELLOW}${BOLD}  DATA${RESET}  ${BOLD}${t.name}${RESET}  ${DIM}${t.sourceFile || ""}${RESET}`);
      if (t.inputs?.length) log(`  ${BLUE}refs: ${t.inputs.join(", ")}${RESET}`);
      if (verbose) log(`${GRAY}${t.sql.split("\n").map(l => `    ${l}`).join("\n")}${RESET}`);
    }
  }
  log("");
}

function printCTEStructure(parsed, filename) {
  heading(`CTE Structure: ${filename}`);
  const { ctes, finalDeps } = parsed;
  for (let i = 0; i < ctes.length; i++) {
    const c = ctes[i];
    const deps = c.deps?.length ? ` ${DIM}← ${c.deps.join(", ")}${RESET}` : "";
    const refs = c.externalRefs?.length ? `  ${BLUE}refs: ${c.externalRefs.join(", ")}${RESET}` : "";
    log(`  ${i === ctes.length - 1 && !finalDeps?.length ? "└─" : "├─"} ${CYAN}${BOLD}${c.name}${RESET}${deps}${refs}`);
  }
  if (finalDeps?.length) log(`  └─ ${GREEN}${BOLD}SELECT${RESET} ${DIM}← ${finalDeps.join(", ")}${RESET}`);
  log("");
}

/* ═══════════════════════════════════════════════
   Template loading
   ═══════════════════════════════════════════════ */
let _templateCache = null;
function loadTemplate() {
  if (!_templateCache) {
    const templatePath = join(__dirname, "../src/template.html");
    try {
      _templateCache = readFileSync(templatePath, "utf-8");
    } catch (e) {
      const detail = e.code === 'ENOENT' ? 'File not found. Reinstall dbt-test-reviewer.' : e.message;
      throw new Error(`Failed to load template: ${templatePath} — ${detail}`);
    }
  }
  return _templateCache;
}

/* ═══════════════════════════════════════════════
   Serve — full interactive UI
   ═══════════════════════════════════════════════ */
function buildFullHTML(data) {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  const template = loadTemplate();
  if (!template.includes('<!-- DATA_PLACEHOLDER -->')) {
    throw new Error('template.html is missing the <!-- DATA_PLACEHOLDER --> marker');
  }
  return template.replace('<!-- DATA_PLACEHOLDER -->', json);
}


function startServer(dir, port, patterns) {
  let cachedData = loadAll(dir, patterns);
  let cacheValid = true;

  // fs.watch for cache invalidation
  const nodeVer = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVer >= 20) {
    try {
      watch(dir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const ext = extname(filename).toLowerCase();
        if ([".yml", ".yaml", ".sql", ".html"].includes(ext)) {
          if (ext === ".html") _templateCache = null;
          cacheValid = false;
          log(`${DIM}${new Date().toLocaleTimeString()} \u2014 Changed: ${filename}${RESET}`);
        }
      });
    } catch (e) {
      warn(`fs.watch failed (${e.message}) \u2014 falling back to full reload per request`);
      cacheValid = false; // force reload on every request
    }
  } else {
    warn(`Node ${nodeVer} detected \u2014 fs.watch recursive requires Node 20+; using full reload per request`);
    cacheValid = false; // disable caching, reload every request
  }

  function getCachedData() {
    if (!cacheValid) {
      cacheValid = true; // set before sync work to prevent redundant reloads
      cachedData = loadAll(dir, patterns);
      if (nodeVer < 20) cacheValid = false; // keep disabled when no watcher
    }
    return cachedData;
  }

  const server = createServer((req, res) => {
    try {
      if (req.url === "/api/data") {
        const data = getCachedData();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } else {
        const data = getCachedData();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildFullHTML(data));
        log(`${DIM}${new Date().toLocaleTimeString()} \u2014 Served ${data.allTests.length} tests from ${data.fileCount} files${RESET}`);
      }
    } catch (e) {
      process.stderr.write(`Request error: ${e.message}\n`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      error(`Port ${port} is already in use. Try: dbt-test-review serve --port ${port + 1}`);
    } else {
      error(`Server error: ${e.message}`);
    }
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    heading("dbt Test Reviewer \u2014 Local Preview Server");
    log(`\n  ${BOLD}http://localhost:${port}${RESET}`);
    log(`  ${DIM}Watching: ${dir} (fs.watch)${RESET}`);
    log(`  ${DIM}File changes are auto-reflected${RESET}\n`);
  });
}

/* ═══════════════════════════════════════════════
   Markdown output
   ═══════════════════════════════════════════════ */
function outputMarkdown(dir, patterns) {
  const { allTests, cteResults, coverageData, semanticWarnings } = loadAll(dir, patterns);
  process.stdout.write(testsToMarkdown(allTests, {
    title: "dbt Test Review",
    cteResults: Object.keys(cteResults).length ? cteResults : undefined,
    coverageData: coverageData.length ? coverageData : undefined,
    semanticWarnings: semanticWarnings.length ? semanticWarnings : undefined,
  }));
}

/* ═══════════════════════════════════════════════
   Demo — static HTML with sample data
   ═══════════════════════════════════════════════ */
function buildDemoData() {
  return {
    allTests: [
      {
        type: "unit", name: "test_order_total_calculation", model: "fct_orders",
        description: "Verify that order total = qty * unit_price with discount applied",
        sourceFile: "models/marts/unit_tests.yml",
        given: [
          { input: "ref('stg_orders')", rows: [
            { order_id: 1, customer_id: 101, qty: 3, unit_price: 29.99, discount: 0.1, status: "shipped" },
            { order_id: 2, customer_id: 102, qty: 1, unit_price: 99.00, discount: null, status: "pending" },
            { order_id: 3, customer_id: 101, qty: 2, unit_price: 15.50, discount: 0.0, status: "returned" },
          ]},
        ],
        expect: [
          { order_id: 1, total: 80.97 },
          { order_id: 2, total: 99.00 },
          { order_id: 3, total: 31.00 },
        ],
        branchAnalysis: [
          { type: "case_when", condition: "status = 'returned'", columns: ["status"], covered: true, coverageNote: "possibly covered" },
          { type: "case_when", condition: "status = 'pending'", columns: ["status"], covered: true, coverageNote: "possibly covered" },
          { type: "case_when", condition: "discount IS NULL", columns: ["discount"], covered: true, coverageNote: "possibly covered" },
          { type: "case_else", condition: "ELSE", columns: [], covered: false, coverageNote: "ELSE reachability not analysed" },
          { type: "coalesce", condition: "discount IS NULL", columns: ["discount"], covered: true, coverageNote: "possibly covered" },
        ],
      },
      { type: "schema", name: "unique", model: "fct_orders", column: "order_id", description: "Surrogate key", data_type: "integer", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "not_null", model: "fct_orders", column: "order_id", description: "Surrogate key", data_type: "integer", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "not_null", model: "fct_orders", column: "customer_id", description: "FK to dim_customers", data_type: "integer", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "relationships", model: "fct_orders", column: "customer_id", description: "FK to dim_customers", data_type: "integer",
        config: { to: "ref('dim_customers')", field: "customer_id" }, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "not_null", model: "fct_orders", column: "order_date", description: "Date the order was placed", data_type: "date", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "accepted_values", model: "fct_orders", column: "status", description: "Order fulfillment status", data_type: "varchar",
        config: { values: ["pending", "shipped", "delivered", "returned", "cancelled"] }, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "not_null", model: "fct_orders", column: "total", description: "Calculated order total", data_type: "numeric", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "dbt_utils.accepted_range", model: "fct_orders", column: "total", description: "Calculated order total", data_type: "numeric",
        config: { min_value: 0, inclusive: true }, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "dbt_utils.unique_combination_of_columns", model: "fct_orders", column: "(model-level)", description: "", data_type: null,
        config: { combination_of_columns: ["order_id", "order_date"] }, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "unique", model: "dim_customers", column: "customer_id", description: "Primary key", data_type: "integer", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "not_null", model: "dim_customers", column: "customer_id", description: "Primary key", data_type: "integer", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "not_null", model: "dim_customers", column: "customer_name", description: "Full name", data_type: "varchar", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "not_null", model: "dim_customers", column: "email", description: "Contact email", data_type: "varchar", config: {}, sourceFile: "models/marts/schema.yml" },
      { type: "schema", name: "unique", model: "dim_customers", column: "email", description: "Contact email", data_type: "varchar", config: {}, sourceFile: "models/marts/schema.yml" },
      {
        type: "data", name: "assert_no_orphan_orders", description: "All orders must have a valid customer",
        sourceFile: "tests/assert_no_orphan_orders.sql", model: "fct_orders",
        sql: "-- name: assert_no_orphan_orders\n-- description: All orders must have a valid customer\n\nWITH orders AS (\n    SELECT * FROM {{ ref('fct_orders') }}\n),\ncustomers AS (\n    SELECT * FROM {{ ref('dim_customers') }}\n)\n\nSELECT o.order_id\nFROM orders o\nLEFT JOIN customers c ON o.customer_id = c.customer_id\nWHERE c.customer_id IS NULL",
        inputs: ["fct_orders", "dim_customers"],
      },
    ],
    coverageData: [
      {
        model: "fct_orders", total: 7, tested: 5, excluded: 1, untested: 1, coveragePercent: 86,
        columns: [
          { name: "order_id", description: "Surrogate key", data_type: "integer", status: "tested", excludeReason: "", testCount: 2 },
          { name: "customer_id", description: "FK to dim_customers", data_type: "integer", status: "tested", excludeReason: "", testCount: 2 },
          { name: "order_date", description: "Date the order was placed", data_type: "date", status: "tested", excludeReason: "", testCount: 1 },
          { name: "status", description: "Order fulfillment status", data_type: "varchar", status: "tested", excludeReason: "", testCount: 1 },
          { name: "total", description: "Calculated order total", data_type: "numeric", status: "tested", excludeReason: "", testCount: 2 },
          { name: "discount", description: "Applied discount rate", data_type: "numeric", status: "untested", excludeReason: "", testCount: 0 },
          { name: "internal_memo", description: "Internal processing note", data_type: "varchar", status: "excluded", excludeReason: "Internal field, not exposed in semantic layer", testCount: 0 },
        ],
      },
      {
        model: "dim_customers", total: 4, tested: 3, excluded: 0, untested: 1, coveragePercent: 75,
        columns: [
          { name: "customer_id", description: "Primary key", data_type: "integer", status: "tested", excludeReason: "", testCount: 2 },
          { name: "customer_name", description: "Full name", data_type: "varchar", status: "tested", excludeReason: "", testCount: 1 },
          { name: "email", description: "Contact email", data_type: "varchar", status: "tested", excludeReason: "", testCount: 2 },
          { name: "signup_date", description: "Registration date", data_type: "date", status: "untested", excludeReason: "", testCount: 0 },
        ],
      },
    ],
    semanticModels: [
      {
        name: "orders_semantic", modelRef: "fct_orders",
        measures: [
          { name: "total_revenue", agg: "sum", expr: "total", description: "Total revenue" },
          { name: "order_count", agg: "count", expr: "order_id", description: "Number of orders" },
          { name: "avg_discount", agg: "average", expr: "discount", description: "Average discount rate" },
        ],
        dimensions: [
          { name: "order_date", type: "time", expr: "order_date", description: "" },
          { name: "status", type: "categorical", expr: "status", description: "" },
        ],
        entities: [
          { name: "order", type: "primary", expr: "order_id" },
          { name: "customer", type: "foreign", expr: "customer_id" },
        ],
      },
    ],
    metrics: [
      { name: "total_revenue", label: "Total Revenue", description: "Total order revenue", type: "simple", measure: "total_revenue", expr: null, metrics: [], filter: null },
      { name: "avg_order_value", label: "Avg Order Value", description: "Average value per order", type: "derived", measure: null, expr: "total_revenue / order_count", metrics: ["total_revenue", "order_count"], filter: null },
    ],
    semanticWarnings: [
      { semanticModel: "orders_semantic", model: "fct_orders", kind: "measure", item: "avg_discount", column: "discount",
        detail: "agg: average", issue: "no_tests", hint: 'measure "avg_discount" (agg: average) references column "discount" which has no tests' },
    ],
    fileContents: {
      "models/marts/unit_tests.yml": "unit_tests:\n  - name: test_order_total_calculation\n    model: fct_orders\n    description: \"Verify that order total = qty * unit_price with discount applied\"\n    given:\n      - input: ref('stg_orders')\n        rows:\n          - {order_id: 1, customer_id: 101, qty: 3, unit_price: 29.99, discount: 0.1, status: shipped}\n          - {order_id: 2, customer_id: 102, qty: 1, unit_price: 99.00, discount: null, status: pending}\n          - {order_id: 3, customer_id: 101, qty: 2, unit_price: 15.50, discount: 0.0, status: returned}\n    expect:\n      rows:\n        - {order_id: 1, total: 80.97}\n        - {order_id: 2, total: 99.00}\n        - {order_id: 3, total: 31.00}\n",
      "models/marts/schema.yml": "models:\n  - name: fct_orders\n    description: \"Fact table for orders\"\n    columns:\n      - name: order_id\n        description: \"Surrogate key\"\n        data_type: integer\n        tests:\n          - unique\n          - not_null\n      - name: customer_id\n        description: \"FK to dim_customers\"\n        data_type: integer\n        tests:\n          - not_null\n          - relationships:\n              to: ref('dim_customers')\n              field: customer_id\n      - name: order_date\n        description: \"Date the order was placed\"\n        data_type: date\n        tests:\n          - not_null\n      - name: status\n        description: \"Order fulfillment status\"\n        data_type: varchar\n        tests:\n          - accepted_values:\n              values: [pending, shipped, delivered, returned, cancelled]\n      - name: total\n        description: \"Calculated order total\"\n        data_type: numeric\n        tests:\n          - not_null\n          - dbt_utils.accepted_range:\n              min_value: 0\n              inclusive: true\n      - name: discount\n        description: \"Applied discount rate\"\n        data_type: numeric\n      - name: internal_memo\n        description: \"Internal processing note\"\n        data_type: varchar\n        meta:\n          no_test: true\n          reason: \"Internal field, not exposed in semantic layer\"\n    tests:\n      - dbt_utils.unique_combination_of_columns:\n          combination_of_columns: [order_id, order_date]\n\n  - name: dim_customers\n    description: \"Customer dimension\"\n    columns:\n      - name: customer_id\n        description: \"Primary key\"\n        data_type: integer\n        tests:\n          - unique\n          - not_null\n      - name: customer_name\n        description: \"Full name\"\n        data_type: varchar\n        tests:\n          - not_null\n      - name: email\n        description: \"Contact email\"\n        data_type: varchar\n        tests:\n          - not_null\n          - unique\n      - name: signup_date\n        description: \"Registration date\"\n        data_type: date\n",
      "tests/assert_no_orphan_orders.sql": "-- name: assert_no_orphan_orders\n-- description: All orders must have a valid customer\n\nWITH orders AS (\n    SELECT * FROM {{ ref('fct_orders') }}\n),\ncustomers AS (\n    SELECT * FROM {{ ref('dim_customers') }}\n)\n\nSELECT o.order_id\nFROM orders o\nLEFT JOIN customers c ON o.customer_id = c.customer_id\nWHERE c.customer_id IS NULL",
    },
    fileCount: 5,
    columnMeta: {},
  };
}

function outputDemo(outDir) {
  const data = buildDemoData();
  data.demoMode = true;
  const html = buildFullHTML(data);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "index.html");
  writeFileSync(outPath, html, "utf-8");
  log(`${GREEN}${BOLD}\u2713${RESET} Demo page generated: ${BOLD}${outPath}${RESET}`);
  log(`  ${DIM}${data.allTests.length} tests, ${data.coverageData.length} models, ${data.semanticWarnings.length} semantic warnings${RESET}`);
  log(`\n  ${DIM}To preview locally:${RESET}`);
  log(`  ${CYAN}open ${outPath}${RESET}`);
  log(`\n  ${DIM}For GitHub Pages, push to main and set Pages source to docs/${RESET}\n`);
}

/* ═══════════════════════════════════════════════
   Main
   ═══════════════════════════════════════════════ */
const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  log(`
${BOLD}dbt-test-reviewer${RESET} — Visualize dbt test input/output for review

${BOLD}Usage:${RESET}
  dbt-test-review preview [path...]    Show tests in terminal
  dbt-test-review serve [options]      Start local preview server (full UI)
  dbt-test-review export [path...]     Export static HTML
  dbt-test-review markdown [path...]   Output Markdown (for CI)
  dbt-test-review demo [options]       Generate static demo page

${BOLD}Commands:${RESET}
  ${CYAN}preview${RESET}   Parse and display tests in the terminal
            Options: --verbose, -v  Show SQL body for data tests

  ${CYAN}serve${RESET}     Start HTTP server with full review UI
            Auto-refreshes when files change
            Options: --port, -p <num>  Port (default: 3456)
                     --dir, -d <path>  Directory (default: .)

  ${CYAN}export${RESET}    Export self-contained HTML for sharing
            Options: --out, -o <file>  Output file (default: dbt-test-review.html)

  ${CYAN}markdown${RESET}  Output Markdown to stdout

  ${CYAN}demo${RESET}      Generate static HTML demo page with sample data
            Options: --out, -o <dir>  Output directory (default: docs)

${BOLD}Examples:${RESET}
  ${DIM}# Start review server in dbt project${RESET}
  dbt-test-review serve

  ${DIM}# Preview in terminal${RESET}
  dbt-test-review preview models/staging/schema.yml

  ${DIM}# Export static HTML for sharing${RESET}
  dbt-test-review export -o review.html

  ${DIM}# Export only PR changed files${RESET}
  gh pr diff 123 --name-only | xargs dbt-test-review export -o review.html

  ${DIM}# Generate Markdown for CI${RESET}
  dbt-test-review markdown > review.md

  ${DIM}# Generate demo page for GitHub Pages${RESET}
  dbt-test-review demo --out docs
`);
}

if (!command || command === "--help" || command === "-h") { printHelp(); process.exit(0); }

if (command === "preview") {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const paths = args.slice(1).filter(a => !a.startsWith("-"));
  const dirs = paths.length ? paths : ["."];
  const allTests = [], cteResults = {};
  for (const d of dirs) {
    const resolved = resolve(d);
    const stat = statSync(resolved, { throwIfNoEntry: false });
    if (!stat) { error(`Not found: ${d}`); continue; }
    const files = stat.isDirectory() ? findTestFiles(resolved) : [resolved];
    for (const f of files) {
      try {
        const content = readFileSync(f, "utf-8");
        const rel = f.replace(process.cwd() + "/", "");
        const { tests } = parseFile(content, rel);
        allTests.push(...tests);
        if (extname(f).toLowerCase() === ".sql") { const cte = parseCTEs(content); if (cte.ctes.length) cteResults[rel] = cte; }
      } catch (e) { warn(`Skip ${f}: ${e.message}`); }
    }
  }
  if (!allTests.length) { warn("No tests found"); process.exit(1); }
  printTests(allTests, { verbose });
  for (const [file, parsed] of Object.entries(cteResults)) printCTEStructure(parsed, file);
}

else if (command === "serve") {
  const portIdx = args.indexOf("--port") !== -1 ? args.indexOf("--port") : args.indexOf("-p");
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) || 3456 : 3456;
  const dirIdx = args.indexOf("--dir") !== -1 ? args.indexOf("--dir") : args.indexOf("-d");
  // Collect positional args (not options or option values)
  const optionValueIndices = new Set();
  if (portIdx !== -1) optionValueIndices.add(portIdx + 1);
  if (dirIdx !== -1) optionValueIndices.add(dirIdx + 1);
  const paths = args.slice(1).filter((a, i) => !a.startsWith("-") && !optionValueIndices.has(i + 1));
  const dir = dirIdx !== -1 ? resolve(args[dirIdx + 1] || ".") : resolve(".");
  startServer(dir, port, paths);
}

else if (command === "markdown") {
  const paths = args.slice(1).filter(a => !a.startsWith("-"));
  outputMarkdown(paths.length ? resolve(paths[0]) : resolve("."), paths.slice(1));
}

else if (command === "export") {
  const outIdx = args.indexOf("--out") !== -1 ? args.indexOf("--out") : args.indexOf("-o");
  const outFile = resolve(outIdx !== -1 ? (args[outIdx + 1] || "dbt-test-review.html") : "dbt-test-review.html");
  const optionValueIndices = new Set();
  if (outIdx !== -1) optionValueIndices.add(outIdx + 1);
  const paths = args.slice(1).filter((a, i) => !a.startsWith("-") && !optionValueIndices.has(i + 1));
  try {
    // Resolve files: support both directories and individual files (like xargs)
    const inputs = paths.length ? paths : ["."];
    const allFiles = [];
    for (const p of inputs) {
      const resolved = resolve(p);
      const stat = statSync(resolved, { throwIfNoEntry: false });
      if (!stat) { process.stderr.write(`Warning: not found: ${p}\n`); continue; }
      if (stat.isDirectory()) { allFiles.push(...findTestFiles(resolved)); }
      else { allFiles.push(resolved); }
    }
    // Use loadAll-compatible processing
    const baseDir = resolve(".");
    const allTests = [], cteResults = {}, allCoverage = [], allColumnMeta = {}, allSemanticModels = [], allMetrics = [], allModelDescriptions = {};
    const sqlByModel = {}, fileContents = {};
    for (const f of allFiles) {
      try {
        const content = readFileSync(f, "utf-8");
        const rel = f.replace(baseDir + "/", "");
        fileContents[rel] = content;
        const { tests, coverage, columnMeta, semanticModels, metrics, modelDescriptions } = parseFile(content, rel);
        allTests.push(...tests);
        allCoverage.push(...coverage);
        Object.assign(allColumnMeta, columnMeta);
        Object.assign(allModelDescriptions, modelDescriptions || {});
        allSemanticModels.push(...semanticModels);
        allMetrics.push(...(metrics || []));
        if (extname(f).toLowerCase() === ".sql") {
          const cte = parseCTEs(content);
          if (cte.ctes.length) cteResults[rel] = cte;
          const modelName = rel.split("/").pop().replace(/\.sql$/i, "");
          sqlByModel[modelName] = content;
        }
      } catch (e) { process.stderr.write(`Skip ${f}: ${e.message}\n`); }
    }
    for (const t of allTests) {
      if (t.type === "unit" && t.model && sqlByModel[t.model]) {
        const branches = extractBranches(sqlByModel[t.model]);
        const allGivenRows = t.given.flatMap(g => g.rows || []);
        t.branchAnalysis = analyzeBranchCoverage(branches, allGivenRows);
      }
    }
    const semanticWarnings = crossReferenceSemanticCoverage(allSemanticModels, allCoverage);
    const data = { allTests, cteResults, coverageData: allCoverage, columnMeta: allColumnMeta, modelDescriptions: allModelDescriptions, semanticModels: allSemanticModels, metrics: allMetrics, semanticWarnings, fileContents, fileCount: allFiles.length };
    const html = buildFullHTML(data);
    writeFileSync(outFile, html, "utf-8");
    log(`${GREEN}${BOLD}\u2713${RESET} Exported: ${BOLD}${outFile}${RESET}`);
    log(`  ${DIM}${data.allTests.length} tests, ${data.coverageData.length} models${RESET}`);
  } catch (e) { error(e.message); process.exit(1); }
}

else if (command === "demo") {
  const outIdx = args.indexOf("--out") !== -1 ? args.indexOf("--out") : args.indexOf("-o");
  const outDir = outIdx !== -1 ? resolve(args[outIdx + 1] || "docs") : resolve("docs");
  try { outputDemo(outDir); } catch (e) { error(e.message); process.exit(1); }
}

else { error(`Unknown command: ${command}`); printHelp(); process.exit(1); }
