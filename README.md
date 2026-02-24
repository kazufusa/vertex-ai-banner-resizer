# Vertex AI Banner Resizer MCP Server

[日本語版 README](README.ja.md)

An MCP server that converts advertisement banners to the recommended sizes for each platform (Google Ads, Meta, Yahoo Japan, LINE). Beyond simple resizing, when the aspect ratio differs significantly, the server performs **AI-powered layout recomposition using Gemini** to rearrange elements for the new aspect ratio.

## Prerequisites

- Node.js 18+
- GCP project (with Vertex AI API enabled)
- Application Default Credentials (ADC) configured

```bash
gcloud auth application-default login
```

## Installation & Build

```bash
npm install
npm run build
```

## Model

| Model | Purpose | Region |
|-------|---------|--------|
| `gemini-3-pro-image-preview` | Banner layout recomposition (aspect ratio conversion) | `global` |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | Yes |
| `GOOGLE_CLOUD_LOCATION` | GCP region (default: `us-central1`) | No |

## MCP Configuration

### Claude Code

```bash
claude mcp add banner-resizer -- node /path/to/vertex-ai-banner-resizer/dist/index.js
```

With environment variables:

```bash
claude mcp add banner-resizer -e GOOGLE_CLOUD_PROJECT=your-project-id -- node /path/to/vertex-ai-banner-resizer/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

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

## Supported Platforms & Sizes

### Google Ads (Responsive Display)
| Size Name | Dimensions | Aspect Ratio |
|-----------|------------|-------------|
| landscape | 1200x628 | 1.91:1 |
| square | 1200x1200 | 1:1 |
| portrait | 1200x1500 | 4:5 |

### Meta (Facebook/Instagram)
| Size Name | Dimensions | Aspect Ratio |
|-----------|------------|-------------|
| feed_square | 1080x1080 | 1:1 |
| feed_vertical | 1080x1350 | 4:5 |
| stories_reels | 1080x1920 | 9:16 |
| landscape | 1200x628 | 1.91:1 |

### Yahoo Japan (YDA)
| Size Name | Dimensions | Aspect Ratio |
|-----------|------------|-------------|
| responsive_landscape | 2400x1256 | ~1.91:1 |
| responsive_square | 1200x1200 | 1:1 |
| banner | 600x500 | 6:5 |

### LINE
| Size Name | Dimensions | Aspect Ratio |
|-----------|------------|-------------|
| card | 1200x628 | ~1.91:1 |
| square | 1080x1080 | 1:1 |
| small | 600x400 | 3:2 |

## Tools

### `list_platforms`

Returns a list of supported platforms and banner sizes.

**Example input:**
```json
{}
```

**Filter by platform:**
```json
{ "platform": "google_ads" }
```

### `resize_banner`

Converts a banner image to the specified platform and size.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `image_path` | string | Yes | Input image path |
| `platform` | enum | Yes | Target platform |
| `size_name` | string | Yes | Target size name |
| `output_dir` | string | No | Output directory |
| `prompt` | string | No | Additional instructions for AI recomposition |

**Example input:**
```json
{
  "image_path": "/path/to/banner.png",
  "platform": "meta",
  "size_name": "stories_reels",
  "prompt": "Use warm tones for the background"
}
```

**Example output:**
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

> **Note:** The `prompt` parameter does **not override** the base recomposition prompt. It is appended as additional instructions, so the core directives (element preservation, text reproduction, etc.) always remain active.

### `resize_banner_batch`

Converts a banner image to all recommended sizes for a given platform.

**Example input:**
```json
{
  "image_path": "/path/to/banner.png",
  "platform": "google_ads",
  "output_dir": "/path/to/output"
}
```

## Methodology

### Automatic Strategy Selection

The server automatically selects one of four conversion strategies based on the aspect ratio difference between the input image and the target size.

| Condition | Strategy | Description |
|-----------|----------|-------------|
| Exact size match | `copy` | PNG conversion only (no resampling) |
| Aspect ratio diff < 2% | `resize` | High-quality Lanczos3 resampling |
| Aspect ratio diff < 20% | `smart_crop` | Attention-based smart crop + resize |
| Aspect ratio diff >= 20% | `outpaint` | Gemini layout recomposition |

### 1. copy (Exact Size Bypass)

Used when the input image pixel dimensions exactly match the target size. No resampling is performed — only PNG format conversion. This skips unnecessary decode-resample-encode overhead for maximum speed.

**Example:** 1200x1200 -> 1200x1200

### 2. resize (Simple Resize)

Used when aspect ratios are nearly identical. Applies sharp's Lanczos3 kernel for high-quality resampling. All original image content is fully preserved.

**Example:** 1080x1080 -> 1200x1200 (both 1:1)

### 3. smart_crop (Smart Crop)

Used when aspect ratios are moderately different. Uses sharp's attention-based strategy (detecting salient regions) to crop while preserving important content.

**Example:** 1080x1080 (1:1) -> 600x500 (6:5)

### 4. outpaint (Gemini Layout Recomposition)

Used when aspect ratios differ significantly. Leverages `gemini-3-pro-image-preview` image generation to rearrange banner elements for the new aspect ratio.

**Processing Flow:**

```
1. Base64-encode the source banner and send to Gemini
2. Auto-select the closest Gemini-supported aspect ratio
   (1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9)
3. Instruct layout recomposition via base prompt + user additional instructions
4. Gemini generates a new banner with repositioned elements in a single request
5. Resize the output to the exact target dimensions
```

**Prompt Structure:**

The base prompt always includes the following directives:

- Rearrange layout for the target size and aspect ratio
- Preserve all original elements (cards, text, logos, icons, decorative elements, background)
- Maintain each element's original aspect ratio and proportions (no stretching or distortion)
- Naturally extend the background to fill the new canvas
- Maintain visual style, color palette, and typography
- Reproduce Japanese text exactly, character by character
- Never remove existing elements or add new ones

When a `prompt` parameter is provided, it is appended to the base prompt as `Additional instructions:`. The base prompt is never overridden.

**Retry Policy:**

| Item | Value |
|------|-------|
| Max retries | 3 |
| Base delay | 5 seconds |
| Backoff | Exponential (5s x 2^(attempt-1)) |
| Retryable errors | `RESOURCE_EXHAUSTED`, `DEADLINE_EXCEEDED`, `503`, `429` |

**Example:** 1080x1080 (1:1) -> 1200x628 (1.91:1)
- Nearest supported ratio: 16:9 (1.78:1)
- Gemini repositions all elements (text, logos, cards, info blocks) into a landscape layout
- Background is naturally extended to cover the new aspect ratio
- Completed in a single API call

### Capabilities & Limitations

| Capability | Description |
|---|---|
| Layout recomposition | Rearranges banner elements to fit the new aspect ratio |
| Background extension | Naturally extends background patterns/textures to fill the new canvas |
| Content preservation | Maintains text, logos, product images, and other original elements |
| Additional instructions | Append custom directives via the `prompt` parameter |

| Limitation | Description |
|---|---|
| Text fidelity | Japanese text may be slightly altered (font/character reproduction is model-dependent) |
| Non-determinism | The same input may produce slightly different results each time |
| Artifacts | AI generation may introduce minor unintended artifacts |

## Development

```bash
npm run dev    # TypeScript watch mode
npm run build  # Build
npm start      # Start server
```

### E2E Tests

Uses `tmp/test.jpg` as input to run conversions across all platforms and sizes. The MCP server is spawned once and shared across all test cases, minimizing process startup overhead.

```bash
npm run build
node e2e-test/test-e2e-full.mjs         # Full E2E test (13 sizes)
node e2e-test/test-layered-visual.mjs   # Visual inspection test (2 sizes)
```

## License

MIT
