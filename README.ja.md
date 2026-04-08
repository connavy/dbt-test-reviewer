# dbt Test Reviewer

dbt のテスト定義 (unit test / schema test / data test / semantic layer) を可視化して、レビューの認知負荷を下げるツール。依存パッケージなし。

**[Demo](https://connavy.github.io/dbt-test-reviewer/)** | [English](./README.md)

## Quick Start

```bash
# インストール不要 — npx で直接実行
npx dbt-test-review serve

# グローバルインストール
npm install -g dbt-test-reviewer
dbt-test-review serve
```

ブラウザで http://localhost:3456 を開く。

## 機能

- **3カラムレイアウト** — ファイル一覧 | レビューカード | CTE グラフ & ソースビューア
- **レビューワークフロー** — OK / 要修正 / 未確認 ボタン + テスト・カラム単位のコメント
- **カバレッジ追跡** — 全カラムを テスト済 / 除外 (`meta.no_test`) / 未判断 に分類
- **ブランチカバレッジ** — SQL の CASE/COALESCE/IIF 分岐を検出、行番号クリックでソース表示
- **Semantic Layer** — MetricFlow の `semantic_models` / `metrics` をパース、テストカバレッジと突合
- **CTE 依存グラフ** — 右パネルに SVG で表示
- **Claude Code エクスポート** — レビュー結果をプロンプトとしてコピー → AI フォローアップ
- **ライト/ダークテーマ** — システムデフォルトに追従、手動切替可
- **キーボードショートカット** — `j`/`k` カード移動、`1`/`2`/`3` ステータス変更、`b` サイドバー、`e` 右パネル、`?` ヘルプ
- **Git コンテキスト** — 現在のブランチ名をヘッダーに表示
- **自動更新** — fs.watch でファイル変更を検知（ポーリングフォールバック）
- **SQL シンタックスハイライト** — BigQuery 準拠

## CLI コマンド

```bash
dbt-test-review serve [options]      # ローカルレビューサーバー起動 (フル UI)
dbt-test-review preview [path...]    # ターミナルにテスト表示
dbt-test-review export [path...]     # 共有用の自己完結 HTML を出力
dbt-test-review markdown [path...]   # Markdown 出力 (CI 向け)
dbt-test-review demo [options]       # デモページ生成
```

### serve — ローカルレビューサーバー

```bash
dbt-test-review serve
dbt-test-review serve --port 8080 --dir ./models
```

### export — 共有用スタティック HTML

```bash
# プロジェクト全体をエクスポート
dbt-test-review export -o review.html

# PR の変更ファイルだけエクスポート
gh pr diff 123 --name-only | xargs dbt-test-review export -o review.html
```

### preview — ターミナル出力

```bash
dbt-test-review preview
dbt-test-review preview models/staging/schema.yml --verbose
```

### markdown — CI 連携

```bash
dbt-test-review markdown > review.md
dbt-test-review markdown | gh pr comment 123 --body-file -
```

## GitHub Actions — PR に自動コメント

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

## 対応テスト

| 種別 | 対応形式 | 表示内容 |
|------|---------|---------|
| Unit Test | YAML (`unit_tests`) | given の input テーブル + expect テーブル |
| Schema Test | YAML (`models.columns.tests`) | テスト名, カラム, config (accepted_values 等) |
| Model-level Test | YAML (`models.tests`) | モデルレベルのテストバッジ |
| Data Test | SQL ファイル | テスト名, ref/source 一覧, SQL 本文 |
| dbt_utils | YAML | バッジ + config 詳細 |
| CTE 構造 | SQL (`WITH` 句) | 依存グラフ (SVG) |
| Semantic Model | YAML (`semantic_models`) | measures / dimensions / entities + カバレッジ警告 |
| Metrics | YAML (`metrics`) | simple / derived / cumulative, measure との紐づけ |
| Coverage | YAML (`meta.no_test`) | テスト済 / 除外 (理由付き) / 未判断 |

## プロジェクト構成

```
dbt-test-reviewer/
├── bin/cli.mjs          # CLI エントリポイント (preview / serve / export / markdown / demo)
├── src/
│   ├── parser.mjs       # YAML/SQL パーサー + Markdown レンダラー
│   ├── template.html    # HTML UI テンプレート (JS/CSS, プレースホルダー置換)
│   └── action.mjs       # GitHub Actions スクリプト
├── test/
│   └── parser.test.mjs  # パーサーテスト (node:test)
├── docs/
│   └── index.html       # デモページ (CI 自動生成)
├── .github/workflows/
│   ├── dbt-test-review.yml
│   └── update-demo.yml
└── package.json
```

## License

MIT
