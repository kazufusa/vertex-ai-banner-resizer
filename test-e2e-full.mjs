/**
 * Full E2E Test - 全プラットフォーム×全サイズの画像出力テスト
 *
 * tmp/test.jpg を入力として、全14サイズへの変換を実行し、
 * 出力画像のサイズ検証まで行う。
 */
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import sharp from "sharp";

const SERVER_CMD = "node";
const SERVER_ARGS = [resolve("dist/index.js")];
const TEST_IMAGE = resolve("tmp/test.jpg");
const OUTPUT_DIR = resolve("tmp/output");
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;

let passed = 0;
let failed = 0;

// ─── Helpers ───

function callTool(name, args) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(SERVER_CMD, SERVER_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GOOGLE_CLOUD_PROJECT: GCP_PROJECT },
    });

    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", () => {});

    const messages = [
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name, arguments: args } },
    ];

    for (const msg of messages) {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    }
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Timeout (180s)"));
    }, 180000);

    proc.on("close", () => {
      clearTimeout(timeout);
      const lines = stdout.trim().split("\n").filter(Boolean);
      const responses = lines.map((l) => JSON.parse(l));
      const resp = responses.find((r) => r.id === 10);
      if (!resp) return reject(new Error("No response"));
      resolvePromise(resp.result);
    });
  });
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

// ─── Setup ───

console.log("\n=== Full E2E Test: 全サイズ画像出力 ===\n");

const srcMeta = await sharp(TEST_IMAGE).metadata();
console.log(`入力画像: ${TEST_IMAGE} (${srcMeta.width}x${srcMeta.height}, ${srcMeta.format})`);
console.log(`出力先:   ${OUTPUT_DIR}`);
console.log(`GCP PJ:   ${GCP_PROJECT}\n`);

mkdirSync(OUTPUT_DIR, { recursive: true });

// 全プラットフォーム×全サイズの定義
const ALL_SIZES = [
  // Google Ads
  { platform: "google_ads", size: "landscape",            w: 1200, h: 628  },
  { platform: "google_ads", size: "square",               w: 1200, h: 1200 },
  { platform: "google_ads", size: "portrait",             w: 1200, h: 1500 },
  // Meta
  { platform: "meta",       size: "feed_square",          w: 1080, h: 1080 },
  { platform: "meta",       size: "feed_vertical",        w: 1080, h: 1350 },
  { platform: "meta",       size: "stories_reels",        w: 1080, h: 1920 },
  { platform: "meta",       size: "landscape",            w: 1200, h: 628  },
  // Yahoo Japan
  { platform: "yahoo_japan", size: "responsive_landscape", w: 2400, h: 1256 },
  { platform: "yahoo_japan", size: "responsive_square",    w: 1200, h: 1200 },
  { platform: "yahoo_japan", size: "banner",               w: 600,  h: 500  },
  // LINE
  { platform: "line",       size: "card",                 w: 1200, h: 628  },
  { platform: "line",       size: "square",               w: 1080, h: 1080 },
  { platform: "line",       size: "small",                w: 600,  h: 400  },
];

// ─── Tests ───

for (const { platform, size, w, h } of ALL_SIZES) {
  const label = `${platform}/${size} (${w}x${h})`;

  await test(label, async () => {
    const result = await callTool("resize_banner", {
      image_path: TEST_IMAGE,
      platform,
      size_name: size,
      output_dir: OUTPUT_DIR,
      prompt: "Extend the advertisement banner background naturally.",
    });

    if (result.isError) {
      throw new Error(result.content[0].text);
    }

    const data = JSON.parse(result.content[0].text);

    // ファイル存在確認
    if (!existsSync(data.outputPath)) {
      throw new Error(`Output file not found: ${data.outputPath}`);
    }

    // 出力画像のサイズ検証
    const meta = await sharp(data.outputPath).metadata();
    if (meta.width !== w || meta.height !== h) {
      throw new Error(`Size mismatch: expected ${w}x${h}, got ${meta.width}x${meta.height}`);
    }

    console.log(`      → strategy: ${data.strategy}, file: ${data.outputPath.split("/").pop()}`);
  });
}

// ─── Summary ───

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed (total: ${ALL_SIZES.length})`);
console.log("=".repeat(50));

if (passed > 0) {
  console.log(`\n出力画像一覧: ${OUTPUT_DIR}/`);
  const files = (await import("node:fs")).readdirSync(OUTPUT_DIR).sort();
  for (const f of files) {
    const m = await sharp(join(OUTPUT_DIR, f)).metadata();
    console.log(`  ${f} (${m.width}x${m.height})`);
  }
}

console.log();
process.exit(failed > 0 ? 1 : 0);
