/**
 * Layered Recompose 目視確認用テスト
 *
 * meta/landscape (1200x628) と meta/stories_reels (1080x1920) を生成し
 * tmp/output/ に出力する
 *
 * MCP サーバーを1プロセスだけ起動し、全テストケースで使い回すことで高速化。
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

// ─── Shared MCP Server ───

const proc = spawn(SERVER_CMD, SERVER_ARGS, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, GOOGLE_CLOUD_PROJECT: GCP_PROJECT },
});

proc.stderr.on("data", (d) => {
  process.stderr.write(d);
});

// 応答バッファ: id → { resolve, reject }
const pending = new Map();
let buffer = "";

proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop(); // 未完了行を保持
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.result);
      }
    } catch {
      // ignore parse errors
    }
  }
});

proc.on("close", () => {
  for (const { reject } of pending.values()) {
    reject(new Error("Server closed unexpectedly"));
  }
  pending.clear();
});

let nextId = 10;

function sendMessage(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function callTool(name, args) {
  return new Promise((resolvePromise, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timeout (180s)"));
    }, 180000);

    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolvePromise(result);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    sendMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  });
}

// Initialize server
sendMessage({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "1.0.0" },
  },
});

// Wait for initialize response
await new Promise((resolve) => {
  pending.set(0, { resolve, reject: (e) => { throw e; } });
});

sendMessage({ jsonrpc: "2.0", method: "notifications/initialized" });

// ─── Helpers ───

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

console.log("\n=== Layered Recompose 目視確認テスト ===\n");

const srcMeta = await sharp(TEST_IMAGE).metadata();
console.log(`入力画像: ${TEST_IMAGE} (${srcMeta.width}x${srcMeta.height})`);
console.log(`出力先: ${OUTPUT_DIR}\n`);

mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Tests ───

const TARGETS = [
  { platform: "meta", size: "landscape", w: 1200, h: 628 },
  { platform: "meta", size: "stories_reels", w: 1080, h: 1920 },
];

for (const { platform, size, w, h } of TARGETS) {
  const label = `${platform}/${size} (${w}x${h})`;

  await test(label, async () => {
    console.log(`    generating...`);
    const result = await callTool("resize_banner", {
      image_path: TEST_IMAGE,
      platform,
      size_name: size,
      output_dir: OUTPUT_DIR,
    });

    if (result.isError) {
      throw new Error(result.content[0].text);
    }

    const data = JSON.parse(result.content[0].text);

    if (!existsSync(data.outputPath)) {
      throw new Error(`Output file not found: ${data.outputPath}`);
    }

    const meta = await sharp(data.outputPath).metadata();
    if (meta.width !== w || meta.height !== h) {
      throw new Error(`Size mismatch: expected ${w}x${h}, got ${meta.width}x${meta.height}`);
    }

    console.log(`    → strategy: ${data.strategy}, file: ${data.outputPath}`);
  });
}

// ─── Cleanup & Summary ───

proc.stdin.end();

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (passed > 0) {
  console.log(`\n出力画像:`);
  const files = (await import("node:fs")).readdirSync(OUTPUT_DIR).filter(f => f.endsWith(".png")).sort();
  for (const f of files) {
    const m = await sharp(join(OUTPUT_DIR, f)).metadata();
    console.log(`  ${OUTPUT_DIR}/${f} (${m.width}x${m.height})`);
  }
}

console.log();
process.exit(failed > 0 ? 1 : 0);
