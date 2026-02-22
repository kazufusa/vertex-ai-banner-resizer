import { GoogleGenAI, Modality } from "@google/genai";
import sharp from "sharp";
import * as fs from "node:fs";
import { CroppedLayer, DetectedLayer } from "../types/index.js";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
const MODEL_ID = "gemini-3-pro-image-preview";

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    if (!PROJECT_ID) {
      throw new Error(
        "環境変数 GOOGLE_CLOUD_PROJECT が設定されていません。" +
          "GCPプロジェクトIDを設定してください。",
      );
    }
    client = new GoogleGenAI({
      vertexai: true,
      project: PROJECT_ID,
      location: LOCATION,
    });
  }
  return client;
}

export interface LayerAnalysisResult {
  layers: DetectedLayer[];
  backgroundDescription: string;
}

export interface DecomposedLayersResult {
  /** 検出されたレイヤーメタデータ */
  layers: DetectedLayer[];
  /** 透過背景のレイヤー画像（layers と同じ順序） */
  croppedLayers: CroppedLayer[];
  /** 背景の説明文 */
  backgroundDescription: string;
}

/**
 * Gemini テキストモードで元画像を分析し、レイヤー情報を抽出する
 *
 * 各レイヤーのバウンディングボックスは正規化座標（0.0–1.0）で返される
 */
export async function analyzeLayers(
  imagePath: string,
): Promise<LayerAnalysisResult> {
  const genai = getClient();

  const imageBytes = fs.readFileSync(imagePath);
  const base64Image = imageBytes.toString("base64");

  const prompt = `Analyze this advertisement banner image and identify all distinct visual layers/elements.

For each element, provide:
- label: a short descriptive name (e.g. "main_card", "logo", "cta_button", "headline_text")
- category: one of "text", "logo", "card", "icon", "decoration", "product", "other"
- bbox: bounding box as normalized coordinates (0.0 to 1.0) with {x, y, w, h} where x,y is top-left corner
- zIndex: stacking order (0 = bottom-most foreground element, higher = more on top)

Also describe the background in one sentence.

Respond ONLY with valid JSON in this exact format:
{
  "layers": [
    { "label": "example", "category": "card", "bbox": { "x": 0.1, "y": 0.1, "w": 0.5, "h": 0.8 }, "zIndex": 0 }
  ],
  "backgroundDescription": "A gradient blue background with subtle patterns"
}

Do NOT include any text outside the JSON. Do NOT use markdown code fences.`;

  const response = await genai.models.generateContent({
    model: MODEL_ID,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/png",
              data: base64Image,
            },
          },
        ],
      },
    ],
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini からレイヤー分析の応答がありませんでした。");
  }

  return parseAnalysisResponse(text);
}

/**
 * Gemini 画像生成モードで元画像のレイヤー分析と透過分離を1リクエストで行う
 *
 * レスポンスには JSON メタデータ + 各レイヤーの透過PNG画像が含まれる
 */
export async function analyzeAndDecomposeLayers(
  imagePath: string,
): Promise<DecomposedLayersResult> {
  const genai = getClient();

  const imageBytes = fs.readFileSync(imagePath);
  const base64Image = imageBytes.toString("base64");
  const metadata = await sharp(imagePath).metadata();
  const imgW = metadata.width!;
  const imgH = metadata.height!;

  const prompt = `You are a professional image compositor. Analyze this advertisement banner and decompose it into individual layers.

TASK:
1. Identify each distinct visual element (text blocks, logos, cards, icons, decorative elements, products)
2. For EACH element, output it as a separate image with a TRANSPARENT background (PNG with alpha)
3. Each output image should contain ONLY that one element, precisely cropped, with everything else transparent
4. After all images, output a JSON summary

OUTPUT FORMAT — output in this exact order:
- First, output each layer as a separate image (transparent PNG). Before each image, write a single line: "LAYER: <label>"
- Finally, output the JSON metadata block:

{"layers":[{"label":"<same label as above>","category":"<text|logo|card|icon|decoration|product|other>","bbox":{"x":0.0,"y":0.0,"w":0.0,"h":0.0},"zIndex":0}],"backgroundDescription":"<one sentence>"}

RULES:
- bbox uses normalized coordinates (0.0–1.0), x,y = top-left corner
- zIndex: 0 = bottom-most foreground, higher = more on top
- Keep the original pixel quality — do NOT resize or alter the element content
- Include ALL text exactly as shown (including Japanese characters)
- Output between 3 and 15 layers — merge tiny/overlapping elements if needed
- The JSON must be the LAST thing in your response`;

  const response = await genai.models.generateContent({
    model: MODEL_ID,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/png",
              data: base64Image,
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });

  const candidates = response.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error("Gemini からレイヤー分解の応答がありませんでした。");
  }

  const parts = candidates[0].content?.parts;
  if (!parts) {
    throw new Error("Gemini のレスポンスにコンテンツがありません。");
  }

  // レスポンスからテキスト（JSON + ラベル）と画像を順番に抽出
  const imageBuffers: Buffer[] = [];
  const labels: string[] = [];
  let jsonText = "";

  for (const part of parts) {
    if (part.inlineData?.data) {
      // 画像パート
      imageBuffers.push(Buffer.from(part.inlineData.data, "base64"));
    } else if (part.text) {
      // テキストパート — ラベル行とJSON両方を蓄積
      const text = part.text.trim();

      // "LAYER: xxx" 行を抽出
      const labelMatches = text.matchAll(/LAYER:\s*(.+)/g);
      for (const m of labelMatches) {
        labels.push(m[1].trim());
      }

      // JSON部分を探す（最後のテキストブロックに含まれるはず）
      const jsonMatch = text.match(/\{[\s\S]*"layers"[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }
    }
  }

  console.error(
    `[layer-analyzer] 画像 ${imageBuffers.length} 枚, ラベル ${labels.length} 個, JSON: ${jsonText.length > 0 ? "あり" : "なし"}`,
  );

  // JSONが取れなかった場合 — 画像だけでも使えるようにフォールバック
  let analysisResult: { layers: DetectedLayer[]; backgroundDescription: string };
  if (jsonText) {
    analysisResult = parseAnalysisResponse(jsonText);
  } else {
    // JSONなしの場合はラベルから仮のメタデータを生成
    analysisResult = {
      layers: imageBuffers.map((_, i) => ({
        label: labels[i] ?? `layer_${i}`,
        category: "other" as const,
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        zIndex: i,
      })),
      backgroundDescription: "advertisement background",
    };
  }

  // 画像数とレイヤー数を揃える（少ない方に合わせる）
  const count = Math.min(imageBuffers.length, analysisResult.layers.length);
  const layers = analysisResult.layers.slice(0, count);
  const croppedLayers: CroppedLayer[] = [];

  for (let i = 0; i < count; i++) {
    const buf = imageBuffers[i];
    try {
      const meta = await sharp(buf).metadata();
      croppedLayers.push({
        detection: layers[i],
        imageBuffer: buf,
        pixelWidth: meta.width ?? imgW,
        pixelHeight: meta.height ?? imgH,
      });
    } catch (error) {
      console.error(
        `[layer-analyzer] レイヤー "${layers[i].label}" の画像処理に失敗: ${error}`,
      );
    }
  }

  return {
    layers: croppedLayers.map((l) => l.detection),
    croppedLayers,
    backgroundDescription: analysisResult.backgroundDescription,
  };
}

// ─── 共通ユーティリティ ───

function parseAnalysisResponse(text: string): {
  layers: DetectedLayer[];
  backgroundDescription: string;
} {
  // JSON部分を抽出（コードフェンスがあれば除去）
  let jsonStr = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed: { layers: unknown[]; backgroundDescription: string };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `レイヤー分析結果のJSON解析に失敗しました。応答: ${text.slice(0, 500)}`,
    );
  }

  if (!Array.isArray(parsed.layers)) {
    throw new Error("レイヤー分析結果に layers 配列がありません。");
  }

  const layers: DetectedLayer[] = parsed.layers.map((raw: unknown) => {
    const layer = raw as Record<string, unknown>;
    const bbox = layer.bbox as Record<string, number>;

    return {
      label: String(layer.label ?? "unknown"),
      category: validateCategory(String(layer.category ?? "other")),
      bbox: {
        x: clamp(bbox?.x ?? 0, 0, 1),
        y: clamp(bbox?.y ?? 0, 0, 1),
        w: clamp(bbox?.w ?? 0, 0, 1),
        h: clamp(bbox?.h ?? 0, 0, 1),
      },
      zIndex: typeof layer.zIndex === "number" ? layer.zIndex : 0,
    };
  });

  return {
    layers,
    backgroundDescription:
      typeof parsed.backgroundDescription === "string"
        ? parsed.backgroundDescription
        : "advertisement background",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const VALID_CATEGORIES = new Set([
  "text",
  "logo",
  "card",
  "icon",
  "decoration",
  "product",
  "other",
]);

function validateCategory(
  cat: string,
): DetectedLayer["category"] {
  if (VALID_CATEGORIES.has(cat)) {
    return cat as DetectedLayer["category"];
  }
  return "other";
}
