# dbt Test Reviewer

dbt のテスト定義 (unit test / schema test / data test) を可視化して、レビューの負荷を下げるツール。

**[Demo](https://connavy.github.io/dbt-test-reviewer/)** | [English](./README.md)

## 3 つの使い方

### 1. CLI — ターミナルでプレビュー

```bash
# インストール
npm install -g dbt-test-reviewer

# dbt プロジェクトのルートで実行
dbt-test-review preview

# 特定ファイルだけ
dbt-test-review preview models/staging/schema.yml

# SQL の中身も表示
dbt-test-review preview --verbose

# CTE 構造も自動検出して表示
```

出力イメージ:

```
  UNIT  test_order_total → fct_orders
  注文合計金額が正しく計算されることを確認

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

### 2. ローカルプレビューサーバー

```bash
dbt-test-review serve

# ブラウザで http://localhost:3456 を開く
# ファイルを変更したらブラウザをリロード
```

オプション:

```bash
dbt-test-review serve --port 8080 --dir ./models
```

### 3. GitHub Actions — PR に自動コメント

`.github/workflows/dbt-test-review.yml` をリポジトリに追加:

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

**何が起こるか:**

1. PR で YAML/SQL ファイルが変更されるとワークフローが起動
2. 変更ファイルからテストを自動抽出
3. input/output テーブル + CTE 構造を Markdown にレンダリング
4. PR コメントとして投稿 (既存コメントがあれば更新)

**必要な権限:**
- `GITHUB_TOKEN` はワークフロー内で自動提供される (追加設定不要)
- `pull-requests: write` で PR コメントを投稿

## Markdown 出力 (CI 連携)

```bash
# Markdown をファイルに出力
dbt-test-review markdown > review.md

# パイプで他ツールに渡す
dbt-test-review markdown | gh pr comment 123 --body-file -
```

## 対応テスト

| テスト種別 | 対応形式 | 表示内容 |
|-----------|---------|---------|
| Unit Test | YAML (unit_tests) | given の input テーブル + expect テーブル |
| Schema Test | YAML (tests / data_tests) | テスト名, カラム, config (accepted_values 等) |
| Data Test | SQL ファイル | テスト名, ref/source 一覧, SQL 本文 |
| CTE 構造 | SQL (WITH 句) | CTE 依存グラフ |

## プロジェクト構成

```
dbt-test-reviewer/
├── bin/cli.mjs          # CLI エントリポイント
├── src/
│   ├── parser.mjs       # YAML/SQL パーサー + Markdown レンダラー
│   └── action.mjs       # GitHub Actions スクリプト
├── .github/workflows/
│   └── dbt-test-review.yml  # ワークフロー定義
└── package.json
```

## License

MIT
