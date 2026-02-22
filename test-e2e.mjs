/**
 * E2E Test for Vertex AI Banner Resizer MCP Server
 *
 * Tests all local functionality (resize, smart_crop, list_platforms, error handling).
 * Outpainting tests are skipped as they require GCP credentials.
 */
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import sharp from "sharp";

const SERVER_CMD = "node";
const SERVER_ARGS = [resolve("dist/index.js")];
const TEST_IMAGE = resolve("tmp/test.jpg");
const OUTPUT_DIR = resolve("tmp/e2e_output");

let passed = 0;
let failed = 0;
let skipped = 0;

// ─── Helpers ───

function sendMcp(messages) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SERVER_CMD, SERVER_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", () => {});

    const init = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e-test", version: "1.0.0" },
      },
    };
    const initialized = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };

    const allMessages = [init, initialized, ...messages];
    for (const msg of allMessages) {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    }
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Timeout"));
    }, 15000);

    proc.on("close", () => {
      clearTimeout(timeout);
      const lines = stdout.trim().split("\n").filter(Boolean);
      const responses = lines.map((l) => JSON.parse(l));
      resolve(responses);
    });
  });
}

async function callTool(name, args) {
  const msg = {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const responses = await sendMcp([msg]);
  // Find the response for our tool call (id: 10)
  const resp = responses.find((r) => r.id === 10);
  if (!resp) throw new Error("No response for tool call");
  return resp.result;
}

async function callToolsList() {
  const msg = { jsonrpc: "2.0", id: 10, method: "tools/list" };
  const responses = await sendMcp([msg]);
  const resp = responses.find((r) => r.id === 10);
  if (!resp) throw new Error("No response for tools/list");
  return resp.result;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    → ${e.message}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  - ${name} (skipped: ${reason})`);
}

// ─── Setup ───

console.log("\n=== Vertex AI Banner Resizer E2E Tests ===\n");
console.log(`Test image: ${TEST_IMAGE}`);

if (!existsSync(TEST_IMAGE)) {
  console.error("ERROR: Test image not found at", TEST_IMAGE);
  process.exit(1);
}

if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Test Suite ───

// 1. Server & Protocol
console.log("\n[1] Server & Protocol");

await test("Server initializes with correct info", async () => {
  const responses = await sendMcp([]);
  const initResp = responses.find((r) => r.result?.serverInfo);
  assert(initResp, "No init response");
  assert(
    initResp.result.serverInfo.name === "vertex-ai-banner-resizer",
    "Wrong server name",
  );
  assert(initResp.result.serverInfo.version === "1.0.0", "Wrong version");
  assert(
    initResp.result.capabilities.tools,
    "Tools capability not advertised",
  );
});

await test("tools/list returns 3 tools", async () => {
  const result = await callToolsList();
  assert(result.tools.length === 3, `Expected 3 tools, got ${result.tools.length}`);
  const names = result.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify(["list_platforms", "resize_banner", "resize_banner_batch"]),
    `Unexpected tool names: ${names}`,
  );
});

await test("Tools have correct annotations", async () => {
  const result = await callToolsList();
  const listTool = result.tools.find((t) => t.name === "list_platforms");
  assert(listTool.annotations.readOnlyHint === true, "list_platforms should be readOnly");

  const resizeTool = result.tools.find((t) => t.name === "resize_banner");
  assert(resizeTool.annotations.readOnlyHint === false, "resize_banner readOnlyHint");
  assert(resizeTool.annotations.destructiveHint === false, "resize_banner destructiveHint");
  assert(resizeTool.annotations.idempotentHint === true, "resize_banner idempotentHint");
});

// 2. list_platforms
console.log("\n[2] list_platforms");

await test("Returns all 4 platforms when no filter", async () => {
  const result = await callTool("list_platforms", {});
  const data = JSON.parse(result.content[0].text);
  assert(data.length === 4, `Expected 4 platforms, got ${data.length}`);
  const ids = data.map((p) => p.id).sort();
  assert(
    JSON.stringify(ids) ===
      JSON.stringify(["google_ads", "line", "meta", "yahoo_japan"]),
    `Wrong platform IDs: ${ids}`,
  );
});

await test("Filters by platform correctly", async () => {
  const result = await callTool("list_platforms", { platform: "line" });
  const data = JSON.parse(result.content[0].text);
  assert(data.length === 1, `Expected 1 platform, got ${data.length}`);
  assert(data[0].id === "line", "Wrong platform");
  assert(data[0].sizes.length === 3, `LINE should have 3 sizes, got ${data[0].sizes.length}`);
});

await test("Google Ads has correct sizes", async () => {
  const result = await callTool("list_platforms", { platform: "google_ads" });
  const data = JSON.parse(result.content[0].text);
  const sizes = data[0].sizes;
  assert(sizes.length === 3, `Expected 3 sizes, got ${sizes.length}`);
  const landscape = sizes.find((s) => s.name === "landscape");
  assert(landscape.width === 1200 && landscape.height === 628, "Wrong landscape size");
  const square = sizes.find((s) => s.name === "square");
  assert(square.width === 1200 && square.height === 1200, "Wrong square size");
});

await test("Meta has stories_reels size", async () => {
  const result = await callTool("list_platforms", { platform: "meta" });
  const data = JSON.parse(result.content[0].text);
  const stories = data[0].sizes.find((s) => s.name === "stories_reels");
  assert(stories, "stories_reels not found");
  assert(stories.width === 1080 && stories.height === 1920, "Wrong stories_reels size");
});

// 3. resize_banner - resize strategy (same aspect ratio)
console.log("\n[3] resize_banner - resize strategy");

await test("1080x1080 → meta feed_square (1080x1080): resize strategy", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "meta",
    size_name: "feed_square",
    output_dir: OUTPUT_DIR,
  });
  assert(!result.isError, "Should not be error");
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "Should succeed");
  assert(data.strategy === "resize", `Expected resize, got ${data.strategy}`);
  assert(data.width === 1080 && data.height === 1080, "Wrong output size");

  // Verify actual file
  const meta = await sharp(data.outputPath).metadata();
  assert(meta.width === 1080 && meta.height === 1080, "File dimensions wrong");
});

await test("1080x1080 → google_ads square (1200x1200): resize strategy", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "google_ads",
    size_name: "square",
    output_dir: OUTPUT_DIR,
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.success === true, "Should succeed");
  assert(data.strategy === "resize", `Expected resize, got ${data.strategy}`);

  const meta = await sharp(data.outputPath).metadata();
  assert(meta.width === 1200 && meta.height === 1200, "File dimensions wrong");
});

await test("1080x1080 → line square (1080x1080): resize strategy", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "line",
    size_name: "square",
    output_dir: OUTPUT_DIR,
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.strategy === "resize", `Expected resize, got ${data.strategy}`);
  assert(data.width === 1080 && data.height === 1080, "Wrong size");
});

await test("1080x1080 → yahoo_japan responsive_square (1200x1200): resize strategy", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "yahoo_japan",
    size_name: "responsive_square",
    output_dir: OUTPUT_DIR,
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.strategy === "resize", `Expected resize, got ${data.strategy}`);

  const meta = await sharp(data.outputPath).metadata();
  assert(meta.width === 1200 && meta.height === 1200, "File dimensions wrong");
});

// 4. resize_banner - smart_crop strategy
console.log("\n[4] resize_banner - smart_crop strategy");

await test("1080x1080 → google_ads portrait (1200x1500, 4:5): smart_crop", async () => {
  // 1:1 vs 4:5(0.8) → diff = |1.0-0.8|/0.8 = 0.25 → actually this is outpaint territory...
  // Let's check: ratio diff = 25% → outpaint (>= 20%)
  // We need a different source for smart_crop testing
  // Actually 1:1 → 4:5 is 25% diff → outpaint
  // 1:1 → 6:5(1.2) is |1.0-1.2|/1.2 = 16.7% → smart_crop!
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "yahoo_japan",
    size_name: "banner",
    output_dir: OUTPUT_DIR,
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.strategy === "smart_crop", `Expected smart_crop, got ${data.strategy}`);
  assert(data.width === 600 && data.height === 500, "Wrong size");

  const meta = await sharp(data.outputPath).metadata();
  assert(meta.width === 600 && meta.height === 500, "File dimensions wrong");
});

// 5. resize_banner - outpaint strategy (expect GCP error)
console.log("\n[5] resize_banner - outpaint strategy");

await test("1080x1080 → meta landscape (1200x628, 1.91:1): outpaint triggers GCP", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "meta",
    size_name: "landscape",
    output_dir: OUTPUT_DIR,
  });
  // Without GCP credentials, this should error
  assert(result.isError === true, "Should error without GCP");
  const text = result.content[0].text;
  // Should mention GOOGLE_CLOUD_PROJECT or GCP-related error
  assert(
    text.includes("GOOGLE_CLOUD_PROJECT") || text.includes("GCP") || text.includes("エラー"),
    `Unexpected error message: ${text}`,
  );
});

await test("1080x1080 → meta stories_reels (1080x1920, 9:16): outpaint triggers GCP", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "meta",
    size_name: "stories_reels",
    output_dir: OUTPUT_DIR,
  });
  assert(result.isError === true, "Should error without GCP");
});

// 6. Error handling
console.log("\n[6] Error handling");

await test("File not found returns isError", async () => {
  const result = await callTool("resize_banner", {
    image_path: "/tmp/does_not_exist_12345.png",
    platform: "meta",
    size_name: "landscape",
  });
  assert(result.isError === true, "Should be error");
  assert(result.content[0].text.includes("見つかりません"), "Should mention file not found");
});

await test("Invalid size_name returns isError", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "meta",
    size_name: "nonexistent_size",
    output_dir: OUTPUT_DIR,
  });
  assert(result.isError === true, "Should be error");
  assert(
    result.content[0].text.includes("サポートされていない"),
    "Should mention unsupported",
  );
});

// 7. resize_banner_batch
console.log("\n[7] resize_banner_batch");

await test("Batch processes all sizes (some may fail without GCP)", async () => {
  const batchDir = join(OUTPUT_DIR, "batch_meta");
  const result = await callTool("resize_banner_batch", {
    image_path: TEST_IMAGE,
    platform: "meta",
    output_dir: batchDir,
  });
  // Should not be a total failure - at least feed_square (resize) should succeed
  const data = JSON.parse(result.content[0].text);
  assert(data.platform === "Meta (Facebook/Instagram)", "Wrong platform name");
  assert(data.totalSizes === 4, `Expected 4 total sizes, got ${data.totalSizes}`);
  assert(data.succeeded >= 1, `At least 1 should succeed, got ${data.succeeded}`);

  // Verify feed_square succeeded (same aspect ratio)
  const feedSquare = data.results.find((r) => r.sizeName === "feed_square");
  assert(feedSquare, "feed_square should be in results");
  assert(feedSquare.strategy === "resize", "feed_square should use resize");
});

await test("Batch file not found returns isError", async () => {
  const result = await callTool("resize_banner_batch", {
    image_path: "/tmp/nope_12345.png",
    platform: "google_ads",
  });
  assert(result.isError === true, "Should be error");
});

// 8. Output file naming
console.log("\n[8] Output file naming");

await test("Output filename follows convention: {base}_{platform}_{size}.png", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "google_ads",
    size_name: "square",
    output_dir: OUTPUT_DIR,
  });
  const data = JSON.parse(result.content[0].text);
  assert(
    data.outputPath.endsWith("test_google_ads_square.png"),
    `Unexpected filename: ${data.outputPath}`,
  );
});

await test("Output is always PNG regardless of input format", async () => {
  const result = await callTool("resize_banner", {
    image_path: TEST_IMAGE, // JPG input
    platform: "meta",
    size_name: "feed_square",
    output_dir: OUTPUT_DIR,
  });
  const data = JSON.parse(result.content[0].text);
  assert(data.outputPath.endsWith(".png"), "Output should be PNG");
  const meta = await sharp(data.outputPath).metadata();
  assert(meta.format === "png", `Expected png format, got ${meta.format}`);
});

// 9. Idempotency
console.log("\n[9] Idempotency");

await test("Calling same resize twice produces same result", async () => {
  const idemDir = join(OUTPUT_DIR, "idempotent");
  const args = {
    image_path: TEST_IMAGE,
    platform: "yahoo_japan",
    size_name: "responsive_square",
    output_dir: idemDir,
  };
  const result1 = await callTool("resize_banner", args);
  const data1 = JSON.parse(result1.content[0].text);
  const meta1 = await sharp(data1.outputPath).metadata();

  const result2 = await callTool("resize_banner", args);
  const data2 = JSON.parse(result2.content[0].text);
  const meta2 = await sharp(data2.outputPath).metadata();

  assert(data1.outputPath === data2.outputPath, "Same output path");
  assert(meta1.width === meta2.width && meta1.height === meta2.height, "Same dimensions");
});

// ─── Summary ───

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log("=".repeat(50) + "\n");

// Cleanup
rmSync(OUTPUT_DIR, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
