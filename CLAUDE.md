# CLAUDE.md — dbt-test-reviewer

## プロジェクト概要

dbtプロジェクトのテストレビューを効率化するツール。Unit Test / Schema Test / Data Test の input/output を可視化し、レビューの認知負荷を下げる。

## 背景と設計思想

### コードレビューにおける人間とエージェントの役割分担

- **人間がやるべきこと**: ロジックの正しさ、品質が期待する状態にあるかの確認。テストケースの妥当性（業務的に正しいか、エッジケースは網羅されているか）、設計意図の確認、データコントラクトの合意
- **エージェントに任せること**: バグ検出、規約チェック、パフォーマンス指摘、全分岐を通すテストの自動生成

### テストカバレッジの定義

「全カラムにテストがある」ではなく **「全カラムについてテストの有無の判断が明示されている」** をカバレッジ100%とする。

- テスト定義済み → テストあり
- `meta: { no_test: true, reason: "..." }` → 意図的に除外（理由付き）
- 何もなし → 未判断（レビューで確認すべき）

これはセキュリティレビューの accepted risk と同じ構造。

## 現在のアーキテクチャ

```
dbt-test-reviewer/
├── bin/cli.mjs          # CLIエントリポイント (preview / serve / markdown / demo)
├── src/
│   ├── parser.mjs       # 共通パーサー (YAML/SQL/CTE) + Markdownレンダラー
│   ├── template.html    # HTML UIテンプレート (JS/CSS込み、プレースホルダー置換)
│   └── action.mjs       # GitHub Actions スクリプト
├── test/
│   └── parser.test.mjs  # パーサーの自動テスト (node:test)
├── docs/
│   └── index.html       # デモページ (CI自動生成)
├── .github/workflows/
│   ├── dbt-test-review.yml
│   └── update-demo.yml  # デモページ自動再生成
├── package.json
└── CLAUDE.md            # このファイル
```

### 技術スタック

- Node.js (ESM), 依存パッケージなし
- YAMLパーサーは自前実装（再帰下降、dbtサブセット対応）
- CLI serve は vanilla HTML/JS/CSS を返すHTTPサーバー（2秒ポーリングで自動更新）

### パーサーの対応範囲

- **Unit Test**: `unit_tests` YAML定義の given/expect を抽出
- **Schema Test**: `models.columns.tests` + `models.tests` (model-level)
- **Data Test**: SQLファイルの `-- name:` / `-- description:` + `ref()` / `source()` 抽出
- **CTE**: WITH句をパースして依存グラフを構築
- **dbt_utils**: `dbt_utils.*` テストをバッジ表示、config詳細表示
- **カバレッジ**: `meta.no_test` による3分類（テスト済み / 除外 / 未判断）
- **カラムメタデータ**: `description`, `data_type` を表示

## 3つの利用モード

### 1. CLI `serve` (ローカル開発)

```bash
cd your-dbt-project
dbt-test-review serve
# http://localhost:3456 でフルUI
```

- dbtプロジェクトのYAML/SQLを自動スキャン
- ファイル変更を2秒ポーリングで検出、ブラウザが自動更新
- レビューボタン (OK / 要修正 / 未確認) + コメント欄
- モデルごとグルーピング + カラムごとグルーピング
- アコーディオン開閉
- **Claude Codeエクスポート**: レビュー結果をプロンプトとしてコピー → Claude Codeにペースト

### 2. PR レビュー (GitHub連携) — 未実装

- PAT + リポジトリ + PR番号を入力してPRの変更ファイルをレビュー
- 現在は GitHub Actions (CI) モードのみ実装済み

### 3. GitHub Actions (CI)

- `.github/workflows/dbt-test-review.yml` をリポジトリに配置
- YAML/SQLが変更されたPRに自動でテストプレビューコメントを投稿
- 既存コメントがあれば更新（コメントタグで識別）

## UI 設計ルール

### カラーパレット

| 要素 | 色 | 用途 |
|------|-----|------|
| Unit Test | 青 (#58a6ff) | バッジ、フィルタ |
| Schema Test | 紫 (#bc8cff) | バッジ、config key |
| Data Test | オレンジ (#d29922) | バッジ |
| dbt_utils | オレンジ (#d29922) | バッジ |
| model-level | シアン (#39d2c0) | バッジ |
| 未判断カラム | オレンジ (#d29922) | バッジ、ボーダー |
| data_type | シアン (#39d2c0) | チップ |
| OK | 緑 (#56d364) | レビューボタン |
| 要修正 | 赤 (#f85149) | レビューボタン |
| 未確認 | オレンジ (#d29922) | レビューボタン |

### 表示構造

```
モデルヘッダー (アコーディオン) ← クリックで開閉
├── Unit Test カード (アコーディオン)
│   ├── given テーブル (input)
│   └── expect テーブル (output)
├── Data Test カード (アコーディオン)
│   ├── refs
│   └── SQL (シンタックスハイライト)
├── Column カード (カラムごとグルーピング)
│   ├── data_type + description
│   ├── テストバッジ一覧
│   └── config詳細
├── 未判断 Column カード
│   ├── data_type + description
│   └── no_test ガイド
├── Semantic Layer カード (MetricFlow)
│   ├── measures / dimensions / entities
│   └── カバレッジ警告
└── Coverage サマリー (アコーディオン)
    ├── 未判断一覧
    ├── 除外一覧 (理由付き)
    └── テスト済み一覧
```

### レビューの粒度

- Unit Test / Data Test → テスト単位でレビュー
- Schema Test → **カラム単位**でレビュー（同一カラムの複数テストを1枚のカードに集約）
- レビューステータス変更は同カラムの全テストに一括反映

## 想定ユースケース

スタースキーマ化（MetricFlow最適化）における公開モデルのテストレビューを主な用途として設計。

### スタースキーマで特に重要なテスト観点

- ファクトとディメンションの結合整合性（キー欠損、fanout）
- 粒度の保証（`unique_combination_of_columns`）
- メトリクス定義との整合（MetricFlowのmeasure/dimensionが期待する型・粒度・null許容）
- リファクタ前後の数値一貫性（回帰テスト）

## 実装済み（ロードマップ完了分）

- [x] MetricFlow `semantic_models` YAMLのパース対応（`extractSemanticModels` in `parser.mjs`）
  - measures / dimensions / entities の定義を読み取り
  - 元カラムのテストカバレッジとの突き合わせ + 警告表示（`crossReferenceSemanticCoverage`）
- [x] MetricFlow `metrics` YAMLのパース対応（`extractMetrics` in `parser.mjs`）
  - simple / derived / cumulative メトリクスの抽出
  - measure との紐づけ（string / object 両形式対応）
  - Semantic Layer カード内で Metrics → Measures 統合表示
- [x] SQLのCASE/WHERE/COALESCE/IIF分岐を抽出し、unit testカバレッジをヒューリスティック検出（`extractBranches` / `analyzeBranchCoverage` in `parser.mjs`）
- [x] YAMLパーサーのマルチラインストリング（`|`, `>`）対応（基本的なブロックスカラー）
- [x] `dbt-test-review serve` にfs.watch追加（Node 20+で有効、それ以前はポーリングフォールバック）
- [x] パーサーの自動テスト追加（`node:test` + `node:assert`、ゼロ依存維持）
- [x] `cli.mjs` の HTML テンプレート分割（`buildFullHTML()` → `src/template.html`）
- [x] npm パッケージ公開準備（package.json整備、.npmignore、Quick Start）
- [x] ライト/ダークテーマ切替（システムデフォルト対応）
- [x] キーボードショートカット（j/k ナビゲーション、1/2/3 ステータス変更）
- [x] BigQuery準拠のSQLシンタックスハイライト
- [x] CTE依存グラフのSVG表示

## 今後の実装予定

### 中優先度

- [ ] SQL分岐カバレッジの精度向上（現在はヒューリスティック → 正確なパス解析へ）
- [ ] レビュー結果の永続化（localStorage or JSON書き出し）
- [ ] GitHub Actions ワークフローの Reusable Workflow 化
- [ ] PR レビューモード（PAT + PR番号でGitHub連携）

### 低優先度

- [ ] VSCode拡張化
- [ ] アクセシビリティ対応（ARIA ラベル、キーボードナビゲーション）
- [ ] js-yaml への切り替え（自前パーサーの限界時）

## 開発ガイドライン

### ファイル配置

- パーサーロジックの変更は `src/parser.mjs` に集約する
- CLI UI (HTML) は `src/template.html` に��置（`bin/cli.mjs` からプレースホルダー置換で読み込み）

### テスト

`node:test` + `node:assert` による自動テストあり（ゼロ依存維持）:

```bash
npm test  # node --test test/*.test.mjs
```

手動での動作確認は以下で行う:

```bash
# テスト用dbtプロジェクト作成
mkdir -p test-project/models/staging test-project/tests

# CLI preview
cd test-project && node ../dbt-test-reviewer/bin/cli.mjs preview --verbose

# CLI serve
node ../dbt-test-reviewer/bin/cli.mjs serve --port 3456

# Markdown出力
node ../dbt-test-reviewer/bin/cli.mjs markdown
```

### YAML パーサーの既知の制限

- マルチラインストリング（`|`, `>`）は基本対応済み。ただし明示的インデント指定子（`|2` 等）は未対応
- アンカー / エイリアス（`&`, `*`）未対応
- 複雑なネスト（4段以上のリスト内マップ内リスト）で不安定な場合がある
- dbtの一般的なYAML構造（unit_tests, models, sources, semantic_models, metrics）は問題なく動作する

### コミットメッセージ規約

特になし。わかりやすければOK。
