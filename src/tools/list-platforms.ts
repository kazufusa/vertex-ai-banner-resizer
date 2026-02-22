import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getAllPlatformIds,
  getPlatformConfig,
} from "../config/banner-sizes.js";
import { PlatformId } from "../types/index.js";

export function registerListPlatforms(server: McpServer): void {
  server.tool(
    "list_platforms",
    "対応プラットフォームとバナーサイズ一覧を返す",
    {
      platform: z
        .enum(["google_ads", "meta", "yahoo_japan", "line"])
        .optional()
        .describe("特定プラットフォームのみ表示（省略時は全プラットフォーム）"),
    },
    {
      readOnlyHint: true,
      openWorldHint: false,
    },
    async ({ platform }) => {
      const platformIds: PlatformId[] = platform
        ? [platform]
        : getAllPlatformIds();

      const results = platformIds
        .map((id) => getPlatformConfig(id))
        .filter((config) => config !== undefined);

      const formatted = results.map((config) => ({
        id: config.id,
        name: config.displayName,
        sizes: config.sizes.map((s) => ({
          name: s.name,
          width: s.width,
          height: s.height,
          aspectRatio: s.aspectRatio,
        })),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(formatted, null, 2),
          },
        ],
      };
    },
  );
}
