# dbt Test Reviewer

A tool to visualize dbt test definitions (unit test / schema test / data test) and reduce the cognitive load of code review.

**[Demo](https://connavy.github.io/dbt-test-reviewer/)** | [日本語](./README.ja.md)

## Quick Start

```bash
# No install needed — run directly with npx
npx dbt-test-review serve

# Or install globally
npm install -g dbt-test-reviewer
dbt-test-review serve
```

## 3 Ways to Use

### 1. CLI — Preview in Terminal

```bash
# Install
npm install -g dbt-test-reviewer

# Run in the root of your dbt project
dbt-test-review preview

# Specific file only
dbt-test-review preview models/staging/schema.yml

# Show SQL details
dbt-test-review preview --verbose

# CTE structure is auto-detected
```

Example output:

```
  UNIT  test_order_total → fct_orders
  Verify that order totals are calculated correctly

  ↓ INPUT: ref('stg_orders') (3 rows)
  order_id  customer_id  status       quantity
  ────────  ───────────  ──────────   ────────
  1         101          completed    3
  2         102          pending      1

  ↑ EXPECTED OUTPUT (2 rows)
  order_id  total_with_tax  is_active
  ────────  ──────────────  ─────────
  1         3300            true
  2         2700            true
```

### 2. Local Preview Server

```bash
dbt-test-review serve

# Open http://localhost:3456 in your browser
# Reload after making file changes
```

Options:

```bash
dbt-test-review serve --port 8080 --dir ./models
```

### 3. GitHub Actions — Auto-comment on PRs

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

## Markdown Output (CI Integration)

```bash
# Output Markdown to a file
dbt-test-review markdown > review.md

# Pipe to other tools
dbt-test-review markdown | gh pr comment 123 --body-file -
```

## Supported Tests

| Test Type | Format | Display |
|-----------|--------|---------|
| Unit Test | YAML (unit_tests) | given input table + expect table |
| Schema Test | YAML (tests / data_tests) | test name, column, config (accepted_values, etc.) |
| Data Test | SQL files | test name, ref/source list, SQL body |
| CTE Structure | SQL (WITH clause) | CTE dependency graph |

## Project Structure

```
dbt-test-reviewer/
├── bin/cli.mjs          # CLI entry point
├── src/
│   ├── parser.mjs       # YAML/SQL parser + Markdown renderer
│   └── action.mjs       # GitHub Actions script
├── .github/workflows/
│   └── dbt-test-review.yml  # Workflow definition
└── package.json
```

## License

MIT
