// src/parser.mjs
// Shared parser for dbt test files — used by CLI and GitHub Action

/* ═══════════════════════════════════════════════
   YAML Parser (recursive descent, dbt subset)
   ═══════════════════════════════════════════════ */
function parseInlineObj(s) {
  s = s.trim();
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1).trim();
  if (!s) return {};
  const result = {};
  let depth = 0, current = "", pairs = [];
  for (const ch of s) {
    if ("{[(".includes(ch)) depth++;
    if ("}])".includes(ch)) depth--;
    if (ch === "," && depth === 0) { pairs.push(current.trim()); current = ""; }
    else current += ch;
  }
  if (current.trim()) pairs.push(current.trim());
  for (const p of pairs) {
    const ci = p.indexOf(":");
    if (ci === -1) continue;
    const k = p.slice(0, ci).trim().replace(/^['"]|['"]$/g, "");
    let v = p.slice(ci + 1).trim();
    if (v === "null" || v === "~" || v === "") result[k] = null;
    else if (v === "true") result[k] = true;
    else if (v === "false") result[k] = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) result[k] = Number(v);
    else if (v === "''") result[k] = "";
    else if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))
      result[k] = v.slice(1, -1);
    else result[k] = v;
  }
  return result;
}

function parseInlineArr(s) {
  s = s.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1).trim();
  if (!s) return [];
  const items = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if ("{[".includes(ch)) depth++;
    if ("}]".includes(ch)) depth--;
    if (ch === "," && depth === 0) { items.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items.map(parseScalar);
}

function stripInlineComment(s) {
  // Strip YAML inline comments: " # comment" outside of quotes
  let inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && i > 0 && s[i - 1] === ' ') {
      return s.slice(0, i - 1).trimEnd();
    }
  }
  return s;
}

function parseScalar(v) {
  v = stripInlineComment(v.trim());
  if (v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))
    return v.slice(1, -1);
  if (v.startsWith("{")) return parseInlineObj(v);
  if (v.startsWith("[")) return parseInlineArr(v);
  return v;
}

export function parseYaml(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const t = raw.replace(/\s+$/, "");
    if (!t || t.trim().startsWith("#")) continue;
    lines.push({ indent: t.search(/\S/), content: t.trim() });
  }
  let pos = 0;
  const peek = () => (pos < lines.length ? lines[pos] : null);

  const MAX_DEPTH = 50;
  function parseNode(mi, depth = 0) {
    if (depth > MAX_DEPTH) {
      // Skip remaining lines at this indent level to avoid infinite recursion
      while (pos < lines.length && peek() && peek().indent >= mi) pos++;
      return undefined;
    }
    const l = peek();
    if (!l || l.indent < mi) return undefined;
    if (l.content.startsWith("- ")) return parseSeq(l.indent, depth);
    if (l.content.includes(":")) return parseMap(l.indent, depth);
    pos++;
    return parseScalar(l.content);
  }
  function parseMap(mi, depth = 0) {
    const r = {};
    while (pos < lines.length) {
      const l = peek();
      if (!l || l.indent < mi) break;
      if (l.indent > mi) { pos++; continue; }
      if (l.content.startsWith("- ")) break;
      const ci = l.content.indexOf(":");
      if (ci === -1) { pos++; continue; }
      const key = l.content.slice(0, ci).trim();
      const rest = l.content.slice(ci + 1).trim();
      pos++;
      if (rest && /^[|>][+-]?$/.test(rest)) {
        // Multiline block scalar (| literal, > folded, with optional chomping indicator)
        const folded = rest.startsWith(">");
        const blockLines = [];
        while (pos < lines.length) {
          const n = peek();
          if (!n || n.indent <= mi) break;
          blockLines.push(n.content);
          pos++;
        }
        r[key] = folded ? blockLines.join(" ") : blockLines.join("\n");
      } else if (rest) r[key] = parseScalar(rest);
      else {
        const n = peek();
        r[key] = n && n.indent > mi ? parseNode(n.indent, depth + 1) : null;
      }
    }
    return r;
  }
  function parseSeq(li, depth = 0) {
    const r = [];
    while (pos < lines.length) {
      const l = peek();
      if (!l || l.indent < li || l.indent !== li || !l.content.startsWith("- ")) break;
      const after = l.content.slice(2).trim();
      if (!after) {
        pos++;
        const n = peek();
        r.push(n && n.indent > li ? parseNode(n.indent, depth + 1) : null);
      } else if (after.startsWith("{")) {
        r.push(parseInlineObj(after));
        pos++;
      } else if (after.includes(":")) {
        const ici = li + 2;
        const ci = after.indexOf(":");
        const key = after.slice(0, ci).trim();
        const rest = after.slice(ci + 1).trim();
        pos++;
        const obj = {};
        if (rest && /^[|>][+-]?$/.test(rest)) {
          const folded = rest.startsWith(">");
          const bl = [];
          while (pos < lines.length && peek() && peek().indent > li) { bl.push(peek().content); pos++; }
          obj[key] = folded ? bl.join(" ") : bl.join("\n");
        } else if (rest) obj[key] = parseScalar(rest);
        else {
          const n = peek();
          obj[key] = n && n.indent >= ici ? parseNode(n.indent, depth + 1) : null;
        }
        while (pos < lines.length) {
          const n = peek();
          if (!n || n.indent < ici) break;
          if (n.indent === ici && n.content.startsWith("- ")) break;
          if (n.indent === ici && n.content.includes(":")) {
            const c2 = n.content.indexOf(":");
            const k = n.content.slice(0, c2).trim();
            const v = n.content.slice(c2 + 1).trim();
            pos++;
            if (v && /^[|>][+-]?$/.test(v)) {
              const folded = v.startsWith(">");
              const bl = [];
              while (pos < lines.length && peek() && peek().indent > ici) { bl.push(peek().content); pos++; }
              obj[k] = folded ? bl.join(" ") : bl.join("\n");
            } else if (v) obj[k] = parseScalar(v);
            else {
              const nn = peek();
              obj[k] = nn && nn.indent > ici ? parseNode(nn.indent, depth + 1) : null;
            }
          } else if (n.indent > ici) {
            pos++;
          } else break;
        }
        r.push(obj);
      } else {
        r.push(parseScalar(after));
        pos++;
      }
    }
    return r;
  }

  const root = parseNode(0);
  if (root && typeof root === "object" && !Array.isArray(root)) {
    while (pos < lines.length) {
      const l = peek();
      if (!l) break;
      if (l.indent === 0 && l.content.includes(":")) Object.assign(root, parseMap(0));
      else pos++;
    }
  }
  return root || {};
}

/* ═══════════════════════════════════════════════
   Test Extraction
   ═══════════════════════════════════════════════ */
export function extractUnitTests(p) {
  if (!Array.isArray(p.unit_tests)) return [];
  return p.unit_tests.filter((t) => t && typeof t === "object").map((t) => ({
    type: "unit",
    name: t.name || "unnamed",
    model: t.model || "unknown",
    description: t.description || "",
    given: Array.isArray(t.given)
      ? t.given
          .filter((g) => g && typeof g === "object")
          .map((g) => ({
            input: g.input || g.ref || "unknown",
            rows: Array.isArray(g.rows) ? g.rows : [],
            fixture: g.fixture || null,
          }))
      : [],
    expect: t.expect
      ? Array.isArray(t.expect.rows)
        ? t.expect.rows
        : Array.isArray(t.expect)
          ? t.expect
          : t.expect.fixture
            ? [{ _fixture: t.expect.fixture }]
            : []
      : [],
  }));
}

export function extractSchemaTests(p) {
  if (!Array.isArray(p.models)) return [];
  const tests = [];
  for (const m of p.models) {
    if (!m) continue;
    // Column-level tests
    for (const col of Array.isArray(m.columns) ? m.columns : []) {
      if (!col) continue;
      for (const ct of (col.tests || col.data_tests || []).filter(Boolean)) {
        const tN = typeof ct === "string" ? ct : Object.keys(ct)[0];
        const tC = typeof ct === "string" ? {} : ct[tN] || {};
        tests.push({
          type: "schema",
          name: tN,
          model: m.name || "?",
          column: col.name || "?",
          description: col.description || "",
          data_type: col.data_type || null,
          config: typeof tC === "object" ? tC : {},
        });
      }
    }
    // Model-level tests
    for (const mt of (m.tests || m.data_tests || []).filter(Boolean)) {
      const tN = typeof mt === "string" ? mt : Object.keys(mt)[0];
      const tC = typeof mt === "string" ? {} : mt[tN] || {};
      tests.push({
        type: "schema",
        name: tN,
        model: m.name || "?",
        column: "(model-level)",
        description: "",
        data_type: null,
        config: typeof tC === "object" ? tC : {},
      });
    }
  }
  return tests;
}

/* ═══════════════════════════════════════════════
   Coverage Extraction
   ═══════════════════════════════════════════════ */
export function extractCoverage(p) {
  if (!Array.isArray(p.models)) return [];
  const results = [];
  for (const m of p.models) {
    if (!m) continue;
    const modelName = m.name || "?";
    const columns = [];
    for (const col of Array.isArray(m.columns) ? m.columns : []) {
      if (!col) continue;
      const colTests = (col.tests || col.data_tests || []).filter(Boolean);
      const meta = col.meta || {};
      let status;
      if (colTests.length > 0) {
        status = "tested";
      } else if (meta.no_test === true || meta.no_test === "true") {
        status = "excluded";
      } else {
        status = "untested";
      }
      columns.push({
        name: col.name || "?",
        description: col.description || "",
        data_type: col.data_type || null,
        status,
        excludeReason: status === "excluded" ? (meta.reason || meta.no_test_reason || "") : "",
        testCount: colTests.length,
      });
    }
    const tested = columns.filter(c => c.status === "tested").length;
    const excluded = columns.filter(c => c.status === "excluded").length;
    const untested = columns.filter(c => c.status === "untested").length;
    results.push({
      model: modelName,
      columns,
      tested,
      excluded,
      untested,
      total: columns.length,
      coveragePercent: columns.length ? Math.round((tested + excluded) / columns.length * 100) : null,
    });
  }
  return results.filter(r => r.total > 0);
}

export function extractColumnMeta(p) {
  if (!Array.isArray(p.models)) return {};
  const meta = {};
  for (const m of p.models) {
    if (!m) continue;
    const modelName = m.name || "?";
    meta[modelName] = {};
    for (const col of Array.isArray(m.columns) ? m.columns : []) {
      if (!col) continue;
      meta[modelName][col.name || "?"] = {
        description: col.description || "",
        data_type: col.data_type || null,
      };
    }
  }
  return meta;
}

export function extractModelDescriptions(p) {
  if (!Array.isArray(p.models)) return {};
  const desc = {};
  for (const m of p.models) {
    if (!m || !m.name) continue;
    if (m.description) desc[m.name] = m.description;
  }
  return desc;
}

/* ═══════════════════════════════════════════════
   Semantic Models (MetricFlow)
   ═══════════════════════════════════════════════ */
export function extractSemanticModels(parsed) {
  if (!Array.isArray(parsed.semantic_models)) return [];
  return parsed.semantic_models.filter(sm => sm && typeof sm === "object").map(sm => {
    const rawModel = (sm.model || "").replace(/\{\{\s*|\s*\}\}/g, "").trim();
    const refMatch = rawModel.match(/ref\(['"]?([^'"()]+)['"]?\)/);
    const modelRef = refMatch ? refMatch[1].trim() : rawModel;
    const measures = (Array.isArray(sm.measures) ? sm.measures : []).filter(Boolean).map(m => ({
      name: m.name || "?",
      agg: m.agg || null,
      expr: m.expr || m.name || "?",
      description: m.description || "",
    }));
    const dimensions = (Array.isArray(sm.dimensions) ? sm.dimensions : []).filter(Boolean).map(d => ({
      name: d.name || "?",
      type: d.type || null,
      typeParams: d.type_params || null,
      expr: d.expr || d.name || "?",
      description: d.description || "",
    }));
    const entities = (Array.isArray(sm.entities) ? sm.entities : []).filter(Boolean).map(e => ({
      name: e.name || "?",
      type: e.type || null,
      expr: e.expr || e.name || "?",
    }));
    return {
      name: sm.name || "?",
      modelRef,
      description: sm.description || "",
      defaults: sm.defaults || {},
      measures,
      dimensions,
      entities,
    };
  });
}

// Resolve semantic model for a metric by matching its measure name
function resolveSemanticModel(smList, measureName) {
  if (!smList || smList.length === 0) return null;
  if (smList.length === 1) return smList[0].name || null;
  // Multiple SMs: find which one defines this measure
  for (const sm of smList) {
    const measures = Array.isArray(sm.measures) ? sm.measures : [];
    if (measures.some(m => (m.name || '') === measureName)) return sm.name || null;
  }
  return smList[0].name || null; // fallback to first
}

export function extractMetrics(parsed) {
  if (!Array.isArray(parsed.metrics)) return [];
  const smList = Array.isArray(parsed.semantic_models)
    ? parsed.semantic_models.filter(Boolean)
    : [];
  return parsed.metrics.filter(m => m && typeof m === "object").map(m => {
    const typeParams = m.type_params || {};
    const filter = m.filter;
    // type_params.measure can be a string or { name, filter }
    const rawMeasure = typeParams.measure || null;
    const measureName = rawMeasure && typeof rawMeasure === "object" ? rawMeasure.name || null : rawMeasure;
    const measureFilter = rawMeasure && typeof rawMeasure === "object" ? rawMeasure.filter || null : null;
    // Collect remaining type_params (window, grain_to_date, etc.)
    const { measure: _m, expr: _e, metrics: _mt, ...otherTypeParams } = typeParams;
    return {
      name: m.name || "?",
      label: m.label || "",
      description: m.description || "",
      type: m.type || "simple",
      measure: measureName,
      measureFilter: measureFilter,
      expr: typeParams.expr || null,
      metrics: Array.isArray(typeParams.metrics) ? typeParams.metrics.map(ref => ref.name || ref).filter(Boolean) : [],
      filter: filter || null,
      typeParams: Object.keys(otherTypeParams).length ? otherTypeParams : null,
      semanticModel: resolveSemanticModel(smList, measureName),
    };
  });
}

export function crossReferenceSemanticCoverage(semanticModels, coverageData) {
  const warnings = [];
  const covByModel = {};
  for (const cov of coverageData) covByModel[cov.model] = cov;

  for (const sm of semanticModels) {
    const cov = covByModel[sm.modelRef];
    if (!cov) continue;
    const colMap = {};
    for (const c of cov.columns) colMap[c.name] = c;

    const checkItems = [
      ...sm.measures.map(m => ({ kind: "measure", item: m.name, column: m.expr, detail: `agg: ${m.agg}` })),
      ...sm.dimensions.map(d => ({ kind: "dimension", item: d.name, column: d.expr, detail: `type: ${d.type}` })),
      ...sm.entities.map(e => ({ kind: "entity", item: e.name, column: e.expr, detail: `type: ${e.type}` })),
    ];

    for (const { kind, item, column, detail } of checkItems) {
      // Only check simple column references (skip SQL expressions like CASE/CONCAT)
      if (!/^[a-zA-Z_]\w*$/.test(column)) continue;
      const col = colMap[column];
      // column_not_found is left to `mf verify-configs`; only warn on untested columns
      if (col?.status === "untested") {
        warnings.push({ semanticModel: sm.name, model: sm.modelRef, kind, item, column, detail, issue: "no_tests",
          hint: `${kind} "${item}" (${detail}) references column "${column}" which has no tests` });
      }
    }
  }
  return warnings;
}

export function parseDataTestSQL(sql) {
  const name = sql.match(/--\s*name:\s*(.+)/i)?.[1]?.trim() || "Data Test";
  const desc = sql.match(/--\s*desc(?:ription)?:\s*(.+)/i)?.[1]?.trim() || "";
  const refs = [...sql.matchAll(/\{\{\s*ref\(['"]([^'"]+)['"]\)\s*\}\}/g)].map((m) => m[1]);
  const sources = [
    ...sql.matchAll(/\{\{\s*source\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)\s*\}\}/g),
  ].map((m) => `${m[1]}.${m[2]}`);
  return { type: "data", name, description: desc, sql, inputs: [...refs, ...sources] };
}

/* ═══════════════════════════════════════════════
   SQL Branch Detection
   ═══════════════════════════════════════════════ */
export function extractBranches(sql) {
  // Build line offset map from original SQL
  const lines = sql.split('\n');
  const lineOffsets = [0];
  for (let i = 0; i < lines.length; i++) lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  function offsetToLine(offset) {
    for (let i = 1; i < lineOffsets.length; i++) {
      if (offset < lineOffsets[i]) return i;
    }
    return lines.length;
  }

  // Strip comments/Jinja with same-length spaces to preserve offsets (keep newlines for line mapping)
  const stripped = sql
    .replace(/--.*$/gm, m => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\{\{[\s\S]*?\}\}/g, m => m.replace(/[^\n]/g, ' '));
  // Collapse newlines for cross-line regex matching, but use original offset for line lookup
  const cleaned = stripped.replace(/\n/g, ' ');

  const branches = [];

  // CASE WHEN ... THEN
  for (const m of cleaned.matchAll(/WHEN\s+((?:(?!\bWHEN\b|\bTHEN\b).)+?)\s+THEN/gi)) {
    branches.push({ type: "case_when", condition: m[1].trim(), line: offsetToLine(m.index) });
  }
  // ELSE (from CASE)
  for (const m of cleaned.matchAll(/ELSE\s+(.+?)(?=\bEND\b)/gi)) {
    const val = m[1].trim();
    if (val) branches.push({ type: "case_else", condition: "ELSE", line: offsetToLine(m.index) });
  }
  // COALESCE
  for (const m of cleaned.matchAll(/COALESCE\s*\(([^,)]+)/gi)) {
    branches.push({ type: "coalesce", condition: `${m[1].trim()} IS NULL`, line: offsetToLine(m.index) });
  }
  // IIF / IF
  for (const m of cleaned.matchAll(/\bI?IF\s*\((.+?)(?:,)/gi)) {
    branches.push({ type: "iif", condition: m[1].trim(), line: offsetToLine(m.index) });
  }

  return branches;
}

const SQL_KEYWORDS = new Set(["and","or","not","is","null","in","between","like","true","false",
  "then","else","end","case","when","as","on","from","where","select","join","left","right","inner",
  "coalesce","lower","upper","trim","cast","nullif","ifnull","date_trunc","date_part","extract",
  "count","sum","avg","min","max","length","substr","substring","replace","concat","round","floor","ceil","abs",
  "current_date","current_timestamp","current_time","now","today","year","month","day","hour","minute","second",
  "date","timestamp","interval","format","parse_date","parse_timestamp","date_add","date_sub","date_diff",
  "datetime","time","generate_date_array","generate_timestamp_array","safe_cast","if","iif","row_number","rank",
  "dense_rank","over","partition","by","order","asc","desc","rows","range","unbounded","preceding","following"]);

function extractConditionColumns(condition) {
  const cleaned = condition
    .replace(/'[^']*'/g, "")
    .replace(/\b\d+\.?\d*\b/g, "")
    .replace(/\b[a-z_]\w*\s*\(/gi, "("); // remove function calls (word followed by parenthesis)
  const cols = [];
  let allQualified = true; // true if every column is table.column qualified
  let hasColumns = false;
  // Prefer table.column pattern — extract just the column part
  for (const m of cleaned.matchAll(/\b[a-z_]\w*\.([a-z_]\w*)\b/gi)) {
    const col = m[1].toLowerCase();
    if (!SQL_KEYWORDS.has(col)) { cols.push(col); hasColumns = true; }
  }
  // Standalone identifiers (not preceded by dot, not followed by dot)
  for (const m of cleaned.matchAll(/(?<!\.)(?<!\w)\b([a-z_]\w*)\b(?!\.)/gi)) {
    const w = m[1].toLowerCase();
    if (!SQL_KEYWORDS.has(w) && !cols.includes(w)) { cols.push(w); hasColumns = true; allQualified = false; }
  }
  return { cols: [...new Set(cols)], allQualified: hasColumns && allQualified };
}

export function analyzeBranchCoverage(branches, givenRows) {
  if (!branches.length) return [];
  const givenCols = new Set();
  const givenValues = {};
  for (const row of givenRows) {
    if (!row || typeof row !== "object") continue;
    for (const [k, v] of Object.entries(row)) {
      const lk = k.toLowerCase();
      givenCols.add(lk);
      if (!givenValues[lk]) givenValues[lk] = new Set();
      givenValues[lk].add(v === null ? "__null__" : String(v).toLowerCase());
    }
  }

  return branches.map(b => {
    const { cols, allQualified } = extractConditionColumns(b.condition);
    const referencedInGiven = cols.some(c => givenCols.has(c));

    // For CASE WHEN col = 'value', check if value appears in given rows
    const checks = [];
    if (referencedInGiven) {
      const eqMatch = b.condition.match(/(\w+)\s*=\s*'([^']*)'/i);
      if (eqMatch) {
        const col = eqMatch[1].toLowerCase();
        const val = eqMatch[2].toLowerCase();
        checks.push(givenValues[col]?.has(val) || false);
      }
      const nullMatch = b.condition.match(/(\w+)\s+IS\s+NULL/i);
      if (nullMatch) {
        const col = nullMatch[1].toLowerCase();
        checks.push(givenValues[col]?.has("__null__") || false);
      }
    }
    // All matched patterns must be satisfied; if none matched, column presence is enough
    const valueCovered = referencedInGiven && (checks.length ? checks.every(Boolean) : true);

    // Table-qualified columns (cte.col) not in given → intermediate CTE column, not testable via input
    const notApplicable = allQualified && !referencedInGiven;
    const covered = notApplicable ? true : b.type === "case_else" ? false : valueCovered;
    const coverageNote = notApplicable ? "n/a (intermediate column)"
      : b.type === "case_else" ? "ELSE reachability not analysed"
      : !referencedInGiven ? "column not in given rows"
      : valueCovered ? "possibly covered" : "value not found in given rows";

    return { ...b, columns: cols, covered, coverageNote };
  });
}

/* ═══════════════════════════════════════════════
   CTE Parser
   ═══════════════════════════════════════════════ */
export function parseCTEs(sql) {
  let cleaned = sql.replace(/--.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const wm = cleaned.match(/\bWITH\b/i);
  if (!wm) return { ctes: [], finalSelect: cleaned.trim() };
  let pos = wm.index + wm[0].length;
  const ctes = [];
  while (pos < cleaned.length) {
    while (pos < cleaned.length && /[\s,]/.test(cleaned[pos])) pos++;
    const rest = cleaned.slice(pos);
    const nm = rest.match(/^(\w+)\s+AS\s*\(/i);
    if (!nm) break;
    const name = nm[1];
    pos += nm[0].length - 1;
    let depth = 1, bs = pos + 1;
    pos++;
    while (pos < cleaned.length && depth > 0) {
      if (cleaned[pos] === "(") depth++;
      if (cleaned[pos] === ")") depth--;
      if ("'\"".includes(cleaned[pos])) {
        const q = cleaned[pos];
        pos++;
        while (pos < cleaned.length && cleaned[pos] !== q) pos++;
      }
      pos++;
    }
    const body = cleaned.slice(bs, pos - 1).trim();
    const refs = [...body.matchAll(/\{\{\s*ref\(['"]([^'"]+)['"]\)\s*\}\}/g)].map((m) => m[1]);
    const srcs = [
      ...body.matchAll(/\{\{\s*source\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)\s*\}\}/g),
    ].map((m) => `${m[1]}.${m[2]}`);
    ctes.push({ name, body, externalRefs: [...refs, ...srcs] });
    while (pos < cleaned.length && /[\s,]/.test(cleaned[pos])) pos++;
    if (/^\w+\s+AS\s*\(/i.test(cleaned.slice(pos))) continue;
    break;
  }
  const finalSelect = cleaned.slice(pos).trim();
  const cteNames = ctes.map((c) => c.name.toLowerCase());
  for (const c of ctes) {
    c.deps = cteNames.filter(
      (n) => n !== c.name.toLowerCase() && new RegExp(`\\b${n}\\b`, "i").test(c.body)
    );
  }
  const finalDeps = cteNames.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(finalSelect));
  return { ctes, finalSelect, finalDeps };
}

/* ═══════════════════════════════════════════════
   Parse file → tests
   ═══════════════════════════════════════════════ */
export function parseFile(content, filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const tests = [];
  let coverage = [];
  let columnMeta = {};
  let semanticModels = [];
  let metrics = [];
  let modelDescriptions = {};
  if (ext === "sql") {
    // Only treat as data test if in tests/ directory or has explicit -- name: comment
    const isTestDir = /(?:^|\/)tests?\//i.test(filename);
    const hasNameComment = /--\s*name:/i.test(content);
    if (isTestDir || hasNameComment) {
      tests.push(parseDataTestSQL(content));
    }
  } else {
    const parsed = parseYaml(content);
    tests.push(...extractUnitTests(parsed));
    tests.push(...extractSchemaTests(parsed));
    coverage = extractCoverage(parsed);
    columnMeta = extractColumnMeta(parsed);
    modelDescriptions = extractModelDescriptions(parsed);
    semanticModels = extractSemanticModels(parsed);
    metrics = extractMetrics(parsed);
  }
  tests.forEach((t) => (t.sourceFile = filename));
  coverage.forEach((c) => (c.sourceFile = filename));
  semanticModels.forEach((sm) => (sm.sourceFile = filename));
  metrics.forEach((mt) => (mt.sourceFile = filename));
  return { tests, coverage, columnMeta, semanticModels, metrics, modelDescriptions };
}

/* ═══════════════════════════════════════════════
   Markdown Renderer
   ═══════════════════════════════════════════════ */
function mdTable(rows) {
  if (!rows?.length) return "_No data_\n";
  const cols = [...new Set(rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))];
  if (!cols.length) return "_No columns_\n";
  const fmt = (v) =>
    v === null || v === undefined ? "`null`" : v === true ? "`true`" : v === false ? "`false`" : `\`${v}\``;
  let md = `| ${cols.join(" | ")} |\n`;
  md += `| ${cols.map(() => "---").join(" | ")} |\n`;
  for (const row of rows) {
    md += `| ${cols.map((c) => fmt(row?.[c])).join(" | ")} |\n`;
  }
  return md;
}

function mdCTEGraph(parsed) {
  const { ctes, finalDeps } = parsed;
  let md = "```\n";
  for (const c of ctes) {
    const deps = c.deps?.length ? ` ← ${c.deps.join(", ")}` : "";
    const refs = c.externalRefs?.length ? ` (refs: ${c.externalRefs.join(", ")})` : "";
    md += `  ${c.name}${deps}${refs}\n`;
  }
  if (finalDeps?.length) md += `  SELECT ← ${finalDeps.join(", ")}\n`;
  md += "```\n";
  return md;
}

export function testsToMarkdown(tests, { title, prNum, cteResults, coverageData, semanticWarnings } = {}) {
  let md = "";

  if (title) md += `## ${title}\n\n`;
  if (prNum) md += `> Auto-generated by **dbt-test-reviewer** for PR #${prNum}\n\n`;

  // Summary
  const counts = { unit: 0, schema: 0, data: 0 };
  tests.forEach((t) => counts[t.type]++);
  const parts = [];
  if (counts.unit) parts.push(`Unit: ${counts.unit}`);
  if (counts.schema) parts.push(`Schema: ${counts.schema}`);
  if (counts.data) parts.push(`Data: ${counts.data}`);
  md += `**${tests.length} tests found** (${parts.join(", ")})\n\n`;

  // Group by source file
  const byFile = {};
  for (const t of tests) {
    const key = t.sourceFile || "(input)";
    if (!byFile[key]) byFile[key] = [];
    byFile[key].push(t);
  }

  for (const [file, fileTests] of Object.entries(byFile)) {
    md += `### 📄 \`${file}\`\n\n`;

    for (const test of fileTests) {
      if (test.type === "unit") {
        md += `<details>\n<summary>🧪 <b>${test.name}</b> → ${test.model}`;
        if (test.description) md += ` — ${test.description}`;
        md += `</summary>\n\n`;
        for (const g of test.given) {
          md += `**Input: \`${g.input}\`** (${g.rows.length} rows)\n\n`;
          md += mdTable(g.rows);
          md += "\n";
        }
        md += `**Expected Output** (${test.expect.length} rows)\n\n`;
        md += mdTable(test.expect);
        md += "\n</details>\n\n";
      } else if (test.type === "schema") {
        const configStr =
          test.config && Object.keys(test.config).length
            ? ` — ${JSON.stringify(test.config)}`
            : "";
        md += `- ✅ **${test.name}** on \`${test.model}.${test.column}\`${configStr}\n`;
      } else if (test.type === "data") {
        md += `<details>\n<summary>🔍 <b>${test.name}</b>`;
        if (test.description) md += ` — ${test.description}`;
        md += `</summary>\n\n`;
        if (test.inputs?.length) {
          md += `**References:** ${test.inputs.map((r) => `\`${r}\``).join(", ")}\n\n`;
        }
        md += "```sql\n" + test.sql + "\n```\n";
        md += "\n</details>\n\n";
      }
    }
  }

  // CTE structure
  if (cteResults) {
    md += `### 🔗 CTE Structure\n\n`;
    for (const [file, parsed] of Object.entries(cteResults)) {
      md += `**\`${file}\`** — ${parsed.ctes.length} CTEs\n\n`;
      md += mdCTEGraph(parsed);
      md += "\n";
    }
  }

  // Coverage
  if (coverageData?.length) {
    md += `### 📊 Coverage\n\n`;
    for (const cov of coverageData) {
      md += `**${cov.model}** — ${cov.coveragePercent}% (${cov.tested} tested, ${cov.excluded} excluded, ${cov.untested} untested)\n\n`;
      if (cov.untested) {
        md += `⚠️ **Untested:** ${cov.columns.filter(c => c.status === "untested").map(c => `\`${c.name}\``).join(", ")}\n\n`;
      }
      if (cov.excluded) {
        for (const c of cov.columns.filter(c => c.status === "excluded")) {
          md += `- 🚫 \`${c.name}\` — ${c.excludeReason || "(no reason given)"}\n`;
        }
        md += "\n";
      }
    }
  }

  // Semantic Layer Warnings
  if (semanticWarnings?.length) {
    md += `### ⚠️ Semantic Layer Warnings\n\n`;
    for (const w of semanticWarnings) {
      md += `- **${w.kind}** \`${w.item}\` → \`${w.model}.${w.column}\`: ${w.hint}\n`;
    }
    md += "\n";
  }

  return md;
}
