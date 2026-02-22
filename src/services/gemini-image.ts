import { GoogleGenAI, Modality } from "@google/genai";
import * as fs from "node:fs";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
const MODEL_ID = "gemini-3-pro-image-preview";

/** リトライ回数 */
const MAX_RETRIES = 3;
/** リトライ間隔の基本値（ミリ秒） */
const RETRY_BASE_DELAY_MS = 5_000;

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

/**
 * アスペクト比文字列に変換する
 * Gemini がサポートする値: "1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"
 */
function toGeminiAspectRatio(
  width: number,
  height: number,
): string | undefined {
  const ratio = width / height;
  const supported = [
    { label: "1:1", value: 1 },
    { label: "2:3", value: 2 / 3 },
    { label: "3:2", value: 3 / 2 },
    { label: "3:4", value: 3 / 4 },
    { label: "4:3", value: 4 / 3 },
    { label: "4:5", value: 4 / 5 },
    { label: "5:4", value: 5 / 4 },
    { label: "9:16", value: 9 / 16 },
    { label: "16:9", value: 16 / 9 },
    { label: "21:9", value: 21 / 9 },
  ];

  // 最も近いアスペクト比を選択
  let best = supported[0];
  let bestDiff = Math.abs(ratio - best.value);
  for (const s of supported) {
    const diff = Math.abs(ratio - s.value);
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best.label;
}

export interface GeminiRecomposeRequest {
  /** 入力画像のファイルパス */
  imagePath: string;
  /** ターゲット幅 */
  targetWidth: number;
  /** ターゲット高さ */
  targetHeight: number;
  /** カスタムプロンプト（省略時はデフォルト） */
  prompt?: string;
}

export interface GeminiRecomposeResponse {
  /** 生成された画像のバッファ */
  imageBuffer: Buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gemini の画像生成機能で、バナーを新しいアスペクト比に再構成する
 *
 * outpainting とは異なり、元画像の要素を再配置・再レイアウトできる
 */
export async function recomposeWithGemini(
  request: GeminiRecomposeRequest,
): Promise<GeminiRecomposeResponse> {
  const genai = getClient();

  const imageBytes = fs.readFileSync(request.imagePath);
  const base64Image = imageBytes.toString("base64");

  const aspectRatio = toGeminiAspectRatio(
    request.targetWidth,
    request.targetHeight,
  );

  const prompt =
    request.prompt ??
    `Rearrange the layout of this advertisement banner for a ${request.targetWidth}x${request.targetHeight} (${aspectRatio}) format. ` +
      "This is a LAYOUT REARRANGEMENT task — reposition and redistribute elements to best fit the new aspect ratio. " +
      "Keep ALL original visual elements: cards, text, logos, icons, decorative elements, and background. " +
      "CRITICAL: Each individual element (cards, icons, text blocks, logos) must preserve its original aspect ratio and proportions. " +
      "Do NOT stretch, squash, or distort any element. " +
      "Extend or fill the background naturally to cover the new canvas area. " +
      "Maintain the exact same visual style, color palette, typography, and brand identity. " +
      "Reproduce all Japanese text exactly as shown in the original, character by character. " +
      "Do NOT remove any existing elements. Do NOT add new text or logos that were not in the original. " +
      "The result should look like a professional banner intentionally designed for this aspect ratio.";

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.error(
        `[gemini-image] リトライ ${attempt}/${MAX_RETRIES} (${delay}ms後)...`,
      );
      await sleep(delay);
    }

    try {
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
          ...(aspectRatio && {
            imageConfig: {
              aspectRatio,
            },
          }),
        },
      });

      // レスポンスから画像を抽出
      const candidates = response.candidates;
      if (!candidates || candidates.length === 0) {
        throw new Error("Gemini から応答がありませんでした。");
      }

      const parts = candidates[0].content?.parts;
      if (!parts) {
        throw new Error("Gemini のレスポンスにコンテンツがありません。");
      }

      for (const part of parts) {
        if (part.inlineData?.data) {
          const imageBuffer = Buffer.from(part.inlineData.data, "base64");
          return { imageBuffer };
        }
      }

      throw new Error(
        "Gemini のレスポンスに画像が含まれていません。" +
          "安全性フィルターにより画像が除外された可能性があります。",
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isRetryable =
        lastError.message.includes("RESOURCE_EXHAUSTED") ||
        lastError.message.includes("DEADLINE_EXCEEDED") ||
        lastError.message.includes("503") ||
        lastError.message.includes("429");

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Unexpected error in recomposeWithGemini");
}

