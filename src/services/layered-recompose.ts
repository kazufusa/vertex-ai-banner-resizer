import { DetectedLayer } from "../types/index.js";
import { recomposeWithGemini } from "./gemini-image.js";

export interface LayeredRecomposeRequest {
  /** 入力画像のファイルパス */
  imagePath: string;
  /** ターゲット幅 */
  targetWidth: number;
  /** ターゲット高さ */
  targetHeight: number;
  /** カスタムプロンプト（省略時はデフォルト） */
  prompt?: string;
}

export interface LayeredRecomposeResponse {
  /** 生成された画像のバッファ */
  imageBuffer: Buffer;
  /** 検出されたレイヤー情報 */
  layers: DetectedLayer[];
  /** 使用された手法 */
  method: "gemini_recompose";
}

/**
 * Gemini にバナーのレイアウト再構成を依頼する
 *
 * gemini-3-pro-image-preview の画像生成能力で、
 * 元バナーの要素を新アスペクト比に合わせて再配置する
 */
export async function layeredRecompose(
  request: LayeredRecomposeRequest,
): Promise<LayeredRecomposeResponse> {
  const { imagePath, targetWidth, targetHeight, prompt } = request;

  console.error(
    `[layered-recompose] Gemini レイアウト再構成: ${targetWidth}x${targetHeight}`,
  );

  const result = await recomposeWithGemini({
    imagePath,
    targetWidth,
    targetHeight,
    prompt: prompt ?? undefined,
  });

  console.error("[layered-recompose] 再構成完了");

  return {
    imageBuffer: result.imageBuffer,
    layers: [],
    method: "gemini_recompose",
  };
}
