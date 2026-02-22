import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import { getPlatformConfig } from "../config/banner-sizes.js";
import { ResizeResult } from "../types/index.js";
import { resizeBanner } from "./resize-banner.js";

export function registerResizeBannerBatch(server: McpServer): void {
  server.tool(
    "resize_banner_batch",
    "バナー画像を指定プラットフォームの全推奨サイズに一括変換する。アスペクト比が異なるサイズにはAI（Imagen 3）によるoutpaintingを使用する。",
    {
      image_path: z.string().describe("入力画像のファイルパス"),
      platform: z
        .enum(["google_ads", "meta", "yahoo_japan", "line"])
        .describe("ターゲットプラットフォーム"),
      output_dir: z
        .string()
        .optional()
        .describe("出力ディレクトリ（デフォルト: 入力画像と同ディレクトリ）"),
      prompt: z
        .string()
        .optional()
        .describe("outpainting時のAIプロンプト（背景の説明等）"),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ image_path, platform, output_dir, prompt }) => {
      try {
        // 入力ファイルの存在確認
        if (!fs.existsSync(image_path)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `エラー: 入力画像が見つかりません: ${image_path}\nファイルパスを確認してください。`,
              },
            ],
            isError: true,
          };
        }

        const platformConfig = getPlatformConfig(platform);
        if (!platformConfig) {
          return {
            content: [
              {
                type: "text" as const,
                text: `エラー: サポートされていないプラットフォームです: ${platform}`,
              },
            ],
            isError: true,
          };
        }

        const results: ResizeResult[] = [];
        const errors: { sizeName: string; error: string }[] = [];

        // 各サイズに対して順次処理
        for (const size of platformConfig.sizes) {
          try {
            const result = await resizeBanner(
              image_path,
              platform,
              size.name,
              output_dir,
              prompt,
            );
            results.push(result);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            errors.push({ sizeName: size.name, error: message });
          }
        }

        const response = {
          platform: platformConfig.displayName,
          totalSizes: platformConfig.sizes.length,
          succeeded: results.length,
          failed: errors.length,
          results,
          ...(errors.length > 0 ? { errors } : {}),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
          ...(errors.length > 0 && results.length === 0
            ? { isError: true }
            : {}),
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
