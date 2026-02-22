import { PredictionServiceClient, helpers } from "@google-cloud/aiplatform";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
const MODEL_ID = "imagen-3.0-capability-001";

/** predict呼び出しのタイムアウト（ミリ秒） */
const PREDICT_TIMEOUT_MS = 120_000;
/** RESOURCE_EXHAUSTED時のリトライ回数 */
const MAX_RETRIES = 3;
/** リトライ間隔の基本値（ミリ秒） */
const RETRY_BASE_DELAY_MS = 5_000;

let client: PredictionServiceClient | null = null;

function getClient(): PredictionServiceClient {
  if (!client) {
    client = new PredictionServiceClient({
      apiEndpoint: `${LOCATION}-aiplatform.googleapis.com`,
    });
  }
  return client;
}

function getEndpoint(): string {
  if (!PROJECT_ID) {
    throw new Error(
      "環境変数 GOOGLE_CLOUD_PROJECT が設定されていません。" +
        "GCPプロジェクトIDを設定してください。",
    );
  }
  return `projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL_ID}`;
}

export interface OutpaintRequest {
  /** outpainting対象のパディング済み画像（PNG Buffer） */
  paddedImageBuffer: Buffer;
  /** マスク画像（PNG Buffer, 白=保持/黒=生成） */
  maskBuffer: Buffer;
  /** AIプロンプト（背景の説明等） */
  prompt: string;
  /** 生成枚数（デフォルト: 1） */
  sampleCount?: number;
  /** プロンプト忠実度（0-500, デフォルト: 75）。高いほどプロンプトに忠実 */
  guidanceScale?: number;
}

export interface OutpaintResponse {
  /** 生成された画像のバッファ配列 */
  images: Buffer[];
  /** RAI情報（安全性フィルター理由） */
  raiReason?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Imagen 3 outpainting APIを呼び出す（リトライ付き）
 */
export async function outpaint(
  request: OutpaintRequest,
): Promise<OutpaintResponse> {
  const predictionClient = getClient();
  const endpoint = getEndpoint();

  const instance = helpers.toValue({
    prompt: request.prompt,
    referenceImages: [
      {
        referenceType: "REFERENCE_TYPE_RAW",
        referenceId: 1,
        referenceImage: {
          bytesBase64Encoded: request.paddedImageBuffer.toString("base64"),
        },
      },
      {
        referenceType: "REFERENCE_TYPE_MASK",
        referenceId: 2,
        referenceImage: {
          bytesBase64Encoded: request.maskBuffer.toString("base64"),
        },
        maskImageConfig: {
          maskMode: "MASK_MODE_USER_PROVIDED",
          dilation: 0.01,
        },
      },
    ],
  });

  const parameters = helpers.toValue({
    editMode: "EDIT_MODE_OUTPAINT",
    sampleCount: request.sampleCount ?? 1,
    ...(request.guidanceScale != null && {
      guidanceScale: request.guidanceScale,
    }),
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.error(
        `[imagen] リトライ ${attempt}/${MAX_RETRIES} (${delay}ms後)...`,
      );
      await sleep(delay);
    }

    try {
      const [response] = await predictionClient.predict(
        {
          endpoint,
          instances: [instance!],
          parameters,
        },
        {
          timeout: PREDICT_TIMEOUT_MS,
        },
      );

      if (!response.predictions || response.predictions.length === 0) {
        const metadata = response.metadata
          ? helpers.fromValue(
              response.metadata as Parameters<typeof helpers.fromValue>[0],
            )
          : null;
        const raiReason =
          metadata && typeof metadata === "object" && metadata !== null
            ? JSON.stringify(metadata)
            : undefined;

        throw new Error(
          `Imagen 3 outpaintingの結果が返されませんでした。` +
            (raiReason
              ? ` 安全性フィルターにより画像が除外された可能性があります: ${raiReason}`
              : ""),
        );
      }

      const images: Buffer[] = [];
      let raiReason: string | undefined;

      for (const prediction of response.predictions) {
        const predValue = helpers.fromValue(
          prediction as Parameters<typeof helpers.fromValue>[0],
        ) as Record<string, unknown>;
        if (predValue.bytesBase64Encoded) {
          images.push(
            Buffer.from(predValue.bytesBase64Encoded as string, "base64"),
          );
        }
        if (predValue.raiFilteredReason) {
          raiReason = predValue.raiFilteredReason as string;
        }
      }

      if (images.length === 0) {
        throw new Error(
          "Imagen 3 outpaintingで画像が生成されませんでした。" +
            (raiReason
              ? ` 安全性フィルター理由: ${raiReason}`
              : " プロンプトを調整してみてください。"),
        );
      }

      return { images, raiReason };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // RESOURCE_EXHAUSTED (8) or DEADLINE_EXCEEDED (4) → リトライ
      const isRetryable =
        lastError.message.includes("RESOURCE_EXHAUSTED") ||
        lastError.message.includes("DEADLINE_EXCEEDED");

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Unexpected error in outpaint");
}
