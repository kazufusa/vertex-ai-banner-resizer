import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerListPlatforms } from "./tools/list-platforms.js";
import { registerResizeBanner } from "./tools/resize-banner.js";
import { registerResizeBannerBatch } from "./tools/resize-banner-batch.js";

const server = new McpServer({
  name: "vertex-ai-banner-resizer",
  version: "1.0.0",
});

// ツールを登録
registerListPlatforms(server);
registerResizeBanner(server);
registerResizeBannerBatch(server);

// エラーハンドリング
server.server.onerror = (error) => {
  console.error("[MCP Server Error]", error);
};

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

// サーバー起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Vertex AI Banner Resizer MCP Server started");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
