# Vertex AI Banner Resizer MCP Server

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
| `imagen-3.0-capability-001` | 背景 outpainting（smart_crop 戦略時のフォールバック等） | `us-central1` |

## 環境変数

| 変数名 | 説明 | 必須 |
|--------|------|------|
| `GOOGLE_CLOUD_PROJECT` | GCPプロジェクトID | Yes |
| `GOOGLE_CLOUD_LOCATION` | GCPリージョン（Imagen用、デフォルト: `us-central1`） | No |

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

**入力例:**
```json
{
  "image_path": "/path/to/banner.png",
  "platform": "meta",
  "size_name": "stories_reels",
  "prompt": "広告バナーの背景を自然に拡張してください"
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
| アスペクト比差 < 2% | `resize` | Lanczos3リサンプリングによる高品質リサイズ |
| アスペクト比差 < 20% | `smart_crop` | attention-basedスマートクロップ + リサイズ |
| アスペクト比差 >= 20% | `outpaint` | Imagen 3 outpaintingによる背景拡張 |

### 1. resize（単純リサイズ）

アスペクト比がほぼ同一の場合に使用。sharpのLanczos3カーネルで高品質にリサンプリングします。元画像の内容は完全に保持されます。

**例**: 1080x1080 → 1200x1200（ともに1:1）

### 2. smart_crop（スマートクロップ）

アスペクト比が近い場合に使用。sharpのattention-based戦略（画像内の注目領域を検出）により、重要なコンテンツを保持しつつクロップします。

**例**: 1080x1080（1:1）→ 600x500（6:5）

### 3. outpaint（Gemini レイアウト再構成）

アスペクト比が大きく異なる場合に使用。`gemini-3-pro-image-preview` の画像生成能力で、元バナーの要素を新しいアスペクト比に合わせて再配置します。

**処理フロー**:

```
1. 元バナー画像を Gemini に入力
2. ターゲットサイズ・アスペクト比を指定してレイアウト再構成を指示
3. Gemini が要素の再配置・背景拡張を含む新バナーを1回のリクエストで生成
4. 出力をターゲットサイズにリサイズ
```

**例**: 1080x1080（1:1）→ 1200x628（1.91:1）の場合
- Gemini が元バナーの全要素（テキスト、ロゴ、カード、情報ブロック等）を横長レイアウトに再配置
- 背景も自然に拡張されて新アスペクト比をカバー
- APIコール1回で完結

### できること・できないこと

| | 説明 |
|---|------|
| **レイアウト再構成** | 元バナーの要素を新しいアスペクト比に合わせて再配置する |
| **背景の拡張** | 元画像の背景パターン・テクスチャを自然に拡張して新キャンバスを埋める |
| **元コンテンツの保持** | テキスト・ロゴ・商品画像など元画像の要素を維持する |
| **プロンプトによる制御** | `prompt`パラメータで再構成の方向性を指定できる |

| | 説明 |
|---|------|
| **テキストの完全再現** | 日本語テキストが微妙に変わる場合がある（フォント・文字の再現性はモデル依存） |
| **生成の非決定性** | 同じ入力でも毎回若干異なる結果が出る可能性がある |
| **新規要素の混入** | AI生成のため、意図しない微小なアーティファクトが混入する場合がある |

## ライセンス

MIT
