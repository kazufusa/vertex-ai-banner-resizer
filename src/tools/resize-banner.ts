import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBannerSize } from "../config/banner-sizes.js";
import { PlatformId, ResizeResult } from "../types/index.js";
import {
  getImageMetadata,
  determineStrategy,
  resizeToExact,
  smartCrop,
} from "../services/image-processor.js";
import { layeredRecompose } from "../services/layered-recompose.js";

export function registerResizeBanner(server: McpServer): void {
  server.tool(
    "resize_banner",
    "バナー画像を指定プラットフォーム・サイズに変換する。アスペクト比が大きく異なる場合はGemini画像生成でアイテム再配置・再レイアウトを行う。",
    {
      image_path: z.string().describe("入力画像のファイルパス"),
      platform: z
        .enum(["google_ads", "meta", "yahoo_japan", "line"])
        .describe("ターゲットプラットフォーム"),
      size_name: z
        .string()
        .describe('サイズ名（例: "landscape", "square", "stories_reels"）'),
      output_dir: z
        .string()
        .optional()
        .describe("出力ディレクトリ（デフォルト: 入力画像と同ディレクトリ）"),
      prompt: z
        .string()
        .optional()
        .describe("AI再構成時のプロンプト（レイアウト指示等）"),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ image_path, platform, size_name, output_dir, prompt }) => {
      try {
        const result = await resizeBanner(
          image_path,
          platform,
          size_name,
          output_dir,
          prompt,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  ...result,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `エラー: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

export async function resizeBanner(
  imagePath: string,
  platform: PlatformId,
  sizeName: string,
  outputDir?: string,
  prompt?: string,
): Promise<ResizeResult> {
  // 入力ファイルの存在確認
  if (!fs.existsSync(imagePath)) {
    throw new Error(
      `入力画像が見つかりません: ${imagePath}\nファイルパスを確認してください。`,
    );
  }

  // プラットフォームとサイズの検証
  const bannerConfig = getBannerSize(platform, sizeName);
  if (!bannerConfig) {
    throw new Error(
      `サポートされていないプラットフォーム/サイズの組み合わせです: ${platform}/${sizeName}\n` +
        `list_platforms ツールで対応サイズを確認してください。`,
    );
  }

  const { size: targetSize } = bannerConfig;

  // 出力ディレクトリの設定
  const outDir = outputDir ?? path.dirname(imagePath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 出力ファイルパスの生成
  const baseName = path.basename(imagePath, path.extname(imagePath));
  const outputPath = path.join(
    outDir,
    `${baseName}_${platform}_${sizeName}.png`,
  );

  // 入力画像のメタデータ取得
  const metadata = await getImageMetadata(imagePath);

  // リサイズ戦略の決定
  const strategy = determineStrategy(
    metadata.width,
    metadata.height,
    targetSize.width,
    targetSize.height,
  );

  switch (strategy) {
    case "resize":
      // アスペクト比が同じ → 単純リサイズ
      await resizeToExact(imagePath, targetSize.width, targetSize.height, outputPath);
      break;

    case "smart_crop":
      // アスペクト比が近い → スマートクロップ
      await smartCrop(imagePath, targetSize.width, targetSize.height, outputPath);
      break;

    case "outpaint": {
      // アスペクト比が大きく異なる → レイヤー分解→再配置パイプライン
      const layeredResult = await layeredRecompose({
        imagePath,
        targetWidth: targetSize.width,
        targetHeight: targetSize.height,
        prompt: prompt ?? undefined,
      });

      console.error(
        `[resize-banner] 手法: ${layeredResult.method}, 検出レイヤー: ${layeredResult.layers.length}`,
      );

      // 生成された画像をターゲットサイズにリサイズして保存
      await resizeToExact(
        layeredResult.imageBuffer,
        targetSize.width,
        targetSize.height,
        outputPath,
      );
      break;
    }
  }

  return {
    outputPath,
    width: targetSize.width,
    height: targetSize.height,
    strategy,
    platform,
    sizeName,
  };
}
