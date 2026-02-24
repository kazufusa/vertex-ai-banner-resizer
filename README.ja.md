# Vertex AI Banner Resizer MCP Server

[English README](README.md)

広告バナーを各プラットフォーム（Google Ads, Meta, Yahoo Japan, LINE）の推奨サイズに変換するMCPサーバです。単純なリサイズだけでなく、アスペクト比が大きく異なる場合は **Gemini の画像生成機能** によるレイアウト再構成を行い、要素を新しいアスペクト比に合わせて再配置します。

## 前提条件

- Node.js 18+
- GCPプロジェクト（Vertex AI API有効化済み）
- Application Default Credentials (ADC) 設定済み

```bash
gcloud auth application-default login
```

## インストール・ビルド

```bash
npm install
npm run build
```

## 使用モデル

| モデル | 用途 | リージョン |
|--------|------|-----------|
| `gemini-3-pro-image-preview` | バナーのレイアウト再構成（アスペクト比変換） | `global` |

## 環境変数

| 変数名 | 説明 | 必須 |
|--------|------|------|
| `GOOGLE_CLOUD_PROJECT` | GCPプロジェクトID | Yes |
| `GOOGLE_CLOUD_LOCATION` | GCPリージョン（デフォルト: `us-central1`） | No |

## MCP設定

### Claude Code

```bash
claude mcp add banner-resizer -- node /path/to/vertex-ai-banner-resizer/dist/index.js
```

環境変数を含める場合:

```bash
claude mcp add banner-resizer -e GOOGLE_CLOUD_PROJECT=your-project-id -- node /path/to/vertex-ai-banner-resizer/dist/index.js
```

### Claude Desktop

`claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "banner-resizer": {
      "command": "node",
      "args": ["/path/to/vertex-ai-banner-resizer/dist/index.js"],
      "env": {
        "GOOGLE_CLOUD_PROJECT": "your-project-id"
      }
    }
  }
}
```

## 対応プラットフォームとサイズ

### Google Ads (Responsive Display)
| サイズ名 | サイズ | アスペクト比 |
|----------|--------|-------------|
| landscape | 1200x628 | 1.91:1 |
| square | 1200x1200 | 1:1 |
| portrait | 1200x1500 | 4:5 |

### Meta (Facebook/Instagram)
| サイズ名 | サイズ | アスペクト比 |
|----------|--------|-------------|
| feed_square | 1080x1080 | 1:1 |
| feed_vertical | 1080x1350 | 4:5 |
| stories_reels | 1080x1920 | 9:16 |
| landscape | 1200x628 | 1.91:1 |

### Yahoo Japan (YDA)
| サイズ名 | サイズ | アスペクト比 |
|----------|--------|-------------|
| responsive_landscape | 2400x1256 | ~1.91:1 |
| responsive_square | 1200x1200 | 1:1 |
| banner | 600x500 | 6:5 |

### LINE
| サイズ名 | サイズ | アスペクト比 |
|----------|--------|-------------|
| card | 1200x628 | ~1.91:1 |
| square | 1080x1080 | 1:1 |
| small | 600x400 | 3:2 |

## ツール

### `list_platforms`

対応プラットフォームとバナーサイズ一覧を返します。

**入力例:**
```json
{}
```

**特定プラットフォームのみ:**
```json
{ "platform": "google_ads" }
```

### `resize_banner`

バナー画像を指定プラットフォーム・サイズに変換します。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| `image_path` | string | Yes | 入力画像パス |
| `platform` | enum | Yes | 対象プラットフォーム |
| `size_name` | string | Yes | 対象サイズ名 |
| `output_dir` | string | No | 出力ディレクトリ |
| `prompt` | string | No | AI再構成への追加指示 |

**入力例:**
```json
{
  "image_path": "/path/to/banner.png",
  "platform": "meta",
  "size_name": "stories_reels",
  "prompt": "背景を暖色系にしてください"
}
```

**出力例:**
```json
{
  "success": true,
  "outputPath": "/path/to/banner_meta_stories_reels.png",
  "width": 1080,
  "height": 1920,
  "strategy": "outpaint",
  "platform": "meta",
  "sizeName": "stories_reels"
}
```

> **Note:** `prompt` パラメータはレイアウト再構成のベースプロンプトを**上書きせず**、末尾に追加指示として付加されます。ベースプロンプトに含まれる要素保持・テキスト再現等の指示は常に有効です。

### `resize_banner_batch`

バナー画像を指定プラットフォームの全推奨サイズに一括変換します。

**入力例:**
```json
{
  "image_path": "/path/to/banner.png",
  "platform": "google_ads",
  "output_dir": "/path/to/output"
}
```

## 手法 (Methodology)

### 戦略の自動選択

入力画像とターゲットサイズのアスペクト比の差に応じて、3つの変換戦略から自動選択します。

| 条件 | 戦略 | 説明 |
|------|------|------|
| サイズ完全一致 | `copy` | PNG変換のみ（リサンプリングなし） |
| アスペクト比差 < 2% | `resize` | Lanczos3リサンプリングによる高品質リサイズ |
| アスペクト比差 < 20% | `smart_crop` | attention-basedスマートクロップ + リサイズ |
| アスペクト比差 >= 20% | `outpaint` | Gemini によるレイアウト再構成 |

### 1. copy（サイズ完全一致時のバイパス）

入力画像のピクセルサイズがターゲットサイズと完全に一致する場合に使用。リサンプリングを行わず、PNG変換のみを実施します。不要なデコード→リサンプリング→エンコードを省略することで高速に処理します。

**例**: 1200x1200 → 1200x1200

### 2. resize（等倍リサイズ）

アスペクト比がほぼ同一の場合に使用。sharpのLanczos3カーネルで高品質にリサンプリングします。元画像の内容は完全に保持されます。

**例**: 1080x1080 → 1200x1200（ともに1:1）

### 3. smart_crop（スマートクロップ）

アスペクト比が近い場合に使用。sharpのattention-based戦略（画像内の注目領域を検出）により、重要なコンテンツを保持しつつクロップします。

**例**: 1080x1080（1:1）→ 600x500（6:5）

### 4. outpaint（Gemini レイアウト再構成）

アスペクト比が大きく異なる場合に使用。`gemini-3-pro-image-preview` の画像生成能力で、元バナーの要素を新しいアスペクト比に合わせて再配置します。

**処理フロー:**

```
1. 元バナー画像をbase64エンコードしてGeminiに入力
2. ターゲットサイズに最も近いGemini対応アスペクト比を自動選択
   (1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9)
3. ベースプロンプト + ユーザー追加指示でレイアウト再構成を指示
4. Geminiが要素の再配置・背景拡張を含む新バナーを1回のリクエストで生成
5. 出力をターゲットサイズに正確にリサイズ
```

**プロンプト構造:**

ベースプロンプトは以下の指示を常に含みます:

- ターゲットサイズ・アスペクト比に合わせたレイアウト再配置
- 全オリジナル要素（カード、テキスト、ロゴ、アイコン、装飾、背景）の保持
- 個々の要素のアスペクト比・プロポーション維持（伸縮歪み禁止）
- 背景の自然な拡張
- ビジュアルスタイル・カラーパレット・タイポグラフィの維持
- 日本語テキストの文字単位での正確な再現
- 既存要素の削除禁止、新規要素の追加禁止

`prompt` パラメータが指定された場合、これらのベース指示の末尾に `Additional instructions:` として追加されます。ベースプロンプトが上書きされることはありません。

**リトライ:**

| 項目 | 値 |
|------|------|
| 最大リトライ回数 | 3回 |
| ベース遅延 | 5秒 |
| バックオフ | 指数（5s × 2^(attempt-1)） |
| リトライ対象 | `RESOURCE_EXHAUSTED`, `DEADLINE_EXCEEDED`, `503`, `429` |

**例**: 1080x1080（1:1）→ 1200x628（1.91:1）の場合
- 最寄りGemini対応比: 16:9（1.78:1）
- Gemini が元バナーの全要素（テキスト、ロゴ、カード、情報ブロック等）を横長レイアウトに再配置
- 背景も自然に拡張されて新アスペクト比をカバー
- APIコール1回で完結

### できること・できないこと

| できること | 説明 |
|---|------|
| レイアウト再構成 | 元バナーの要素を新しいアスペクト比に合わせて再配置する |
| 背景の拡張 | 元画像の背景パターン・テクスチャを自然に拡張して新キャンバスを埋める |
| 元コンテンツの保持 | テキスト・ロゴ・商品画像など元画像の要素を維持する |
| 追加指示による制御 | `prompt`パラメータでベースプロンプトに追加の指示を付加できる |

| できないこと | 説明 |
|---|------|
| テキストの完全再現 | 日本語テキストが微妙に変わる場合がある（フォント・文字の再現性はモデル依存） |
| 生成の決定性保証 | 同じ入力でも毎回若干異なる結果が出る可能性がある |
| アーティファクトの完全排除 | AI生成のため、意図しない微小なアーティファクトが混入する場合がある |

## 開発

```bash
npm run dev    # TypeScript watchモード
npm run build  # ビルド
npm start      # サーバー起動
```

### E2Eテスト

`tmp/test.jpg` を入力として、全プラットフォーム×全サイズへの変換を実行します。MCPサーバーを1プロセスだけ起動し全テストケースで使い回すため、プロセス起動オーバーヘッドは最小限です。

```bash
npm run build
node e2e-test/test-e2e-full.mjs         # 全13サイズE2Eテスト
node e2e-test/test-layered-visual.mjs   # 目視確認用テスト（2サイズ）
```

## ライセンス

MIT
