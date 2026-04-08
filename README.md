# dbt Test Reviewer

A tool to visualize dbt test definitions (unit test / schema test / data test / semantic layer) and reduce the cognitive load of code review. Zero dependencies.

**[Demo](https://connavy.github.io/dbt-test-reviewer/)** | [日本語](./README.ja.md)

## Quick Start

```bash
# No install needed — run directly with npx
npx dbt-test-review serve

# Or install globally
npm install -g dbt-test-reviewer
dbt-test-review serve
```

Open http://localhost:3456 in your browser.

## Features

- **3-column layout** — file sidebar | review cards | CTE graph & source viewer
- **Review workflow** — OK / Needs Change / Pending buttons with comments per test/column
- **Coverage tracking** — classifies every column as tested / excluded (`meta.no_test`) / untested
- **Branch coverage** — detects CASE/COALESCE/IIF branches in SQL with clickable line references
- **Semantic Layer** — parses MetricFlow `semantic_models` and `metrics`, cross-references test coverage
- **CTE dependency graph** — SVG visualization in the right panel
- **Export to Claude Code** — copy review results as a prompt for AI follow-up
- **Light/dark theme** — follows system default, manual toggle available
- **Keyboard shortcuts** — `j`/`k` navigate, `1`/`2`/`3` set status, `b` sidebar, `e` right panel, `?` help
- **Git context** — current branch name displayed in header
- **Auto-refresh** — file changes detected via fs.watch (polling fallback)
- **SQL syntax highlighting** — BigQuery-compatible

## CLI Commands

```bash
dbt-test-review serve [options]      # Start local review server (full UI)
dbt-test-review preview [path...]    # Show tests in terminal
dbt-test-review export [path...]     # Export self-contained HTML for sharing
dbt-test-review markdown [path...]   # Output Markdown (for CI)
dbt-test-review demo [options]       # Generate static demo page
```

### serve — Local Review Server

```bash
dbt-test-review serve
dbt-test-review serve --port 8080 --dir ./models
```

### export — Static HTML for Sharing

```bash
# Export full project
dbt-test-review export -o review.html

# Export only PR changed files
gh pr diff 123 --name-only | xargs dbt-test-review export -o review.html
```

### preview — Terminal Output

```bash
dbt-test-review preview
dbt-test-review preview models/staging/schema.yml --verbose
```

### markdown — CI Integration

```bash
dbt-test-review markdown > review.md
dbt-test-review markdown | gh pr comment 123 --body-file -
```

## GitHub Actions — Auto-comment on PRs

Add `.github/workflows/dbt-test-review.yml` to your repository:

```yaml
name: dbt Test Review

on:
  pull_request:
    paths:
      - "models/**/*.yml"
      - "models/**/*.yaml"
      - "tests/**/*.sql"

permissions:
  contents: read
  pull-requests: write

jobs:
  test-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Run dbt Test Reviewer
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: npx dbt-test-reviewer@latest
```

**What happens:**

1. The workflow triggers when YAML/SQL files are changed in a PR
2. Tests are automatically extracted from changed files
3. Input/output tables + CTE structure are rendered as Markdown
4. Posted as a PR comment (updates existing comment if present)

**Required permissions:**
- `GITHUB_TOKEN` is automatically provided within the workflow (no additional setup needed)
- `pull-requests: write` to post PR comments

## Supported Tests

| Type | Format | Display |
|------|--------|---------|
| Unit Test | YAML (`unit_tests`) | given input table + expect table |
| Schema Test | YAML (`models.columns.tests`) | test name, column, config (accepted_values, etc.) |
| Model-level Test | YAML (`models.tests`) | model-level test badges |
| Data Test | SQL files | test name, ref/source list, SQL body |
| dbt_utils | YAML | badge + config details |
| CTE Structure | SQL (`WITH` clause) | dependency graph (SVG) |
| Semantic Model | YAML (`semantic_models`) | measures / dimensions / entities + coverage warnings |
| Metrics | YAML (`metrics`) | simple / derived / cumulative, linked to measures |
| Coverage | YAML (`meta.no_test`) | tested / excluded (with reason) / untested |

## Project Structure

```
dbt-test-reviewer/
├── bin/cli.mjs          # CLI entry point (preview / serve / export / markdown / demo)
├── src/
│   ├── parser.mjs       # YAML/SQL parser + Markdown renderer
│   ├── template.html    # HTML UI template (JS/CSS, placeholder substitution)
│   └── action.mjs       # GitHub Actions script
├── test/
│   └── parser.test.mjs  # Parser tests (node:test)
├── docs/
│   └── index.html       # Demo page (CI auto-generated)
├── .github/workflows/
│   ├── dbt-test-review.yml
│   └── update-demo.yml
└── package.json
```

## License

MIT
