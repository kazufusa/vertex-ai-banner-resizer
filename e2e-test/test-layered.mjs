/**
 * Layered Recompose パイプラインのテスト
 *
 * ローカル実行可能なテスト（GCP不要）:
 *   - cropLayers: 正規化座標→ピクセル座標変換、パディング、境界クランプ
 *   - computeLayerPlacements: 配置計算（中心位置比率維持）
 *
 * MCP経由テスト（GCP不要だがサーバー起動あり）:
 *   - outpaint戦略が layeredRecompose パスを通ること（GCPエラーで確認）
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import sharp from "sharp";

const TEST_IMAGE = resolve("tmp/test.jpg");
const OUTPUT_DIR = resolve("tmp/layered_test_output");

let passed = 0;
let failed = 0;
let skipped = 0;

// ─── Helpers ───

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

function approxEqual(a, b, tolerance = 0.001) {
  return Math.abs(a - b) < tolerance;
}

function callToolMcp(name, args) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("node", [resolve("dist/index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

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
      reject(new Error("Timeout (30s)"));
    }, 30000);

    proc.on("close", () => {
      clearTimeout(timeout);
      const lines = stdout.trim().split("\n").filter(Boolean);
      const responses = lines.map((l) => JSON.parse(l));
      const resp = responses.find((r) => r.id === 10);
      if (!resp) return reject(new Error("No response"));
      resolvePromise({ result: resp.result, stderr });
    });
  });
}

// ─── Setup ───

console.log("\n=== Layered Recompose Pipeline Tests ===\n");

if (!existsSync(TEST_IMAGE)) {
  console.error("ERROR: Test image not found at", TEST_IMAGE);
  console.error("Run: mkdir -p tmp && create a test image at tmp/test.jpg");
  process.exit(1);
}

if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

// Import modules (compiled JS)
const {
  cropLayers,
  computeLayerPlacements,
  getImageMetadata,
} = await import("../dist/services/image-processor.js");

// ─── [1] cropLayers テスト ───

console.log("\n[1] cropLayers - レイヤークロップ");

await test("単一レイヤーのクロップが正しいサイズを返す", async () => {
  const meta = await getImageMetadata(TEST_IMAGE);
  const layers = [
    {
      label: "test_element",
      category: "card",
      bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      zIndex: 0,
    },
  ];

  const cropped = await cropLayers(TEST_IMAGE, layers);
  assert(cropped.length === 1, `Expected 1 cropped layer, got ${cropped.length}`);
  assert(cropped[0].detection.label === "test_element", "Wrong label");
  assert(cropped[0].imageBuffer instanceof Buffer, "Should be Buffer");
  assert(cropped[0].pixelWidth > 0, "Width should be positive");
  assert(cropped[0].pixelHeight > 0, "Height should be positive");

  // 5%パディング込みのサイズ確認（おおよそ）
  const expectedW = meta.width * 0.3;
  const expectedH = meta.height * 0.4;
  // パディング5%追加なので、クロップ後サイズは元の約110%
  assert(
    cropped[0].pixelWidth >= expectedW * 0.95 &&
      cropped[0].pixelWidth <= expectedW * 1.15,
    `Width ${cropped[0].pixelWidth} not in expected range (${Math.round(expectedW * 0.95)}-${Math.round(expectedW * 1.15)})`,
  );
  assert(
    cropped[0].pixelHeight >= expectedH * 0.95 &&
      cropped[0].pixelHeight <= expectedH * 1.15,
    `Height ${cropped[0].pixelHeight} not in expected range (${Math.round(expectedH * 0.95)}-${Math.round(expectedH * 1.15)})`,
  );
});

await test("複数レイヤーのクロップがすべて返される", async () => {
  const layers = [
    { label: "logo", category: "logo", bbox: { x: 0.0, y: 0.0, w: 0.2, h: 0.1 }, zIndex: 2 },
    { label: "card", category: "card", bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, zIndex: 0 },
    { label: "cta", category: "text", bbox: { x: 0.6, y: 0.8, w: 0.3, h: 0.1 }, zIndex: 1 },
  ];

  const cropped = await cropLayers(TEST_IMAGE, layers);
  assert(cropped.length === 3, `Expected 3 layers, got ${cropped.length}`);

  const labels = cropped.map((c) => c.detection.label);
  assert(labels.includes("logo"), "Missing logo");
  assert(labels.includes("card"), "Missing card");
  assert(labels.includes("cta"), "Missing cta");
});

await test("画像端に接するbboxがクランプされる", async () => {
  const layers = [
    {
      label: "edge_element",
      category: "other",
      bbox: { x: 0.9, y: 0.9, w: 0.2, h: 0.2 },
      zIndex: 0,
    },
  ];

  const cropped = await cropLayers(TEST_IMAGE, layers);
  assert(cropped.length === 1, "Should crop even edge elements");

  // クロップ後の画像が有効であること
  const meta = await sharp(cropped[0].imageBuffer).metadata();
  assert(meta.width > 0 && meta.height > 0, "Cropped image should have positive dimensions");
});

await test("全画面bboxが元画像サイズに近いクロップを返す", async () => {
  const srcMeta = await getImageMetadata(TEST_IMAGE);
  const layers = [
    {
      label: "fullscreen",
      category: "other",
      bbox: { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
      zIndex: 0,
    },
  ];

  const cropped = await cropLayers(TEST_IMAGE, layers);
  assert(cropped.length === 1, "Should return 1 layer");
  // 全画面なのでクロップサイズ≒元画像サイズ
  assert(
    cropped[0].pixelWidth === srcMeta.width,
    `Width should be ${srcMeta.width}, got ${cropped[0].pixelWidth}`,
  );
  assert(
    cropped[0].pixelHeight === srcMeta.height,
    `Height should be ${srcMeta.height}, got ${cropped[0].pixelHeight}`,
  );
});

await test("空のレイヤー配列で空の結果を返す", async () => {
  const cropped = await cropLayers(TEST_IMAGE, []);
  assert(cropped.length === 0, "Should return empty array");
});

await test("クロップ画像がPNGバッファとして有効", async () => {
  const layers = [
    { label: "valid", category: "card", bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, zIndex: 0 },
  ];

  const cropped = await cropLayers(TEST_IMAGE, layers);
  const meta = await sharp(cropped[0].imageBuffer).metadata();
  assert(meta.format === "png", `Expected png, got ${meta.format}`);
});

// ─── [2] computeLayerPlacements テスト ───

console.log("\n[2] computeLayerPlacements - 配置計算");

await test("同一アスペクト比で中心位置が維持される", () => {
  const croppedLayers = [
    {
      detection: {
        label: "center_element",
        category: "card",
        bbox: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        zIndex: 0,
      },
      imageBuffer: Buffer.alloc(0),
      pixelWidth: 500,
      pixelHeight: 500,
    },
  ];

  // 同サイズ 1000x1000 → 1000x1000
  const placements = computeLayerPlacements(croppedLayers, 1000, 1000, 1000, 1000);
  assert(placements.length === 1, "Should return 1 placement");
  assert(placements[0].label === "center_element", "Wrong label");

  const centerX = placements[0].targetBbox.x + placements[0].targetBbox.w / 2;
  const centerY = placements[0].targetBbox.y + placements[0].targetBbox.h / 2;
  assert(approxEqual(centerX, 0.5), `Center X should be ~0.5, got ${centerX}`);
  assert(approxEqual(centerY, 0.5), `Center Y should be ~0.5, got ${centerY}`);
});

await test("横長→縦長への変換でサイズ比率が正しい", () => {
  const croppedLayers = [
    {
      detection: {
        label: "card",
        category: "card",
        bbox: { x: 0.375, y: 0.341, w: 0.25, h: 0.318 },
        zIndex: 0,
      },
      imageBuffer: Buffer.alloc(0),
      pixelWidth: 300,
      pixelHeight: 200,
    },
  ];

  // 横長 1200x628 → 縦長 1080x1920
  const placements = computeLayerPlacements(croppedLayers, 1200, 628, 1080, 1920);
  assert(placements.length === 1, "Should return 1 placement");

  // 元のピクセルサイズ → ターゲットでの正規化サイズ
  const expectedW = (0.25 * 1200) / 1080; // 300/1080 ≈ 0.278
  const expectedH = (0.318 * 628) / 1920; // 199.7/1920 ≈ 0.104
  assert(
    approxEqual(placements[0].targetBbox.w, expectedW, 0.01),
    `Width should be ~${expectedW.toFixed(3)}, got ${placements[0].targetBbox.w.toFixed(3)}`,
  );
  assert(
    approxEqual(placements[0].targetBbox.h, expectedH, 0.01),
    `Height should be ~${expectedH.toFixed(3)}, got ${placements[0].targetBbox.h.toFixed(3)}`,
  );
});

await test("複数レイヤーの配置がすべて返される", () => {
  const croppedLayers = [
    {
      detection: { label: "logo", category: "logo", bbox: { x: 0.05, y: 0.05, w: 0.15, h: 0.1 }, zIndex: 2 },
      imageBuffer: Buffer.alloc(0),
      pixelWidth: 180,
      pixelHeight: 100,
    },
    {
      detection: { label: "card", category: "card", bbox: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, zIndex: 0 },
      imageBuffer: Buffer.alloc(0),
      pixelWidth: 720,
      pixelHeight: 600,
    },
    {
      detection: { label: "cta", category: "text", bbox: { x: 0.3, y: 0.85, w: 0.4, h: 0.1 }, zIndex: 1 },
      imageBuffer: Buffer.alloc(0),
      pixelWidth: 480,
      pixelHeight: 100,
    },
  ];

  const placements = computeLayerPlacements(croppedLayers, 1200, 1000, 1080, 1920);
  assert(placements.length === 3, `Expected 3 placements, got ${placements.length}`);

  const labels = placements.map((p) => p.label);
  assert(labels.includes("logo"), "Missing logo");
  assert(labels.includes("card"), "Missing card");
  assert(labels.includes("cta"), "Missing cta");
});

await test("配置座標が0.0-1.0の範囲内に収まる", () => {
  const croppedLayers = [
    {
      detection: {
        label: "big_element",
        category: "card",
        bbox: { x: 0.0, y: 0.0, w: 0.8, h: 0.8 },
        zIndex: 0,
      },
      imageBuffer: Buffer.alloc(0),
      pixelWidth: 800,
      pixelHeight: 800,
    },
  ];

  // 1000x1000 → 500x1000（幅半分）→ 要素が幅をはみ出す
  const placements = computeLayerPlacements(croppedLayers, 1000, 1000, 500, 1000);
  const bbox = placements[0].targetBbox;

  assert(bbox.x >= 0, `x should be >= 0, got ${bbox.x}`);
  assert(bbox.y >= 0, `y should be >= 0, got ${bbox.y}`);
  assert(bbox.w <= 1, `w should be <= 1, got ${bbox.w}`);
  assert(bbox.h <= 1, `h should be <= 1, got ${bbox.h}`);
});

await test("縦長→横長への変換で中心位置が比率維持される", () => {
  const croppedLayers = [
    {
      detection: {
        label: "centered",
        category: "card",
        bbox: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
        zIndex: 0,
      },
      imageBuffer: Buffer.alloc(0),
      pixelWidth: 400,
      pixelHeight: 400,
    },
  ];

  // 1000x1000 → 2000x1000 (横に倍)
  const placements = computeLayerPlacements(croppedLayers, 1000, 1000, 2000, 1000);
  const centerX = placements[0].targetBbox.x + placements[0].targetBbox.w / 2;
  const centerY = placements[0].targetBbox.y + placements[0].targetBbox.h / 2;

  assert(approxEqual(centerY, 0.5, 0.05), `Center Y should be ~0.5, got ${centerY}`);
  assert(approxEqual(centerX, 0.5, 0.05), `Center X should be ~0.5, got ${centerX}`);
});

await test("空のレイヤー配列で空の配置を返す", () => {
  const placements = computeLayerPlacements([], 1000, 1000, 500, 500);
  assert(placements.length === 0, "Should return empty array");
});

// ─── [3] cropLayers → computeLayerPlacements 統合テスト ───

console.log("\n[3] cropLayers → computeLayerPlacements 統合テスト");

await test("クロップ結果をそのまま配置計算に渡せる", async () => {
  const meta = await getImageMetadata(TEST_IMAGE);
  const layers = [
    { label: "element_a", category: "card", bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.4 }, zIndex: 0 },
    { label: "element_b", category: "text", bbox: { x: 0.5, y: 0.6, w: 0.4, h: 0.2 }, zIndex: 1 },
  ];

  const cropped = await cropLayers(TEST_IMAGE, layers);
  assert(cropped.length === 2, "Should crop 2 layers");

  const placements = computeLayerPlacements(
    cropped,
    meta.width,
    meta.height,
    1080,
    1920,
  );
  assert(placements.length === 2, "Should return 2 placements");
  assert(placements[0].label === "element_a", "First label should be element_a");
  assert(placements[1].label === "element_b", "Second label should be element_b");

  for (const p of placements) {
    assert(p.targetBbox.x >= 0, `${p.label} x >= 0`);
    assert(p.targetBbox.y >= 0, `${p.label} y >= 0`);
    assert(p.targetBbox.w > 0, `${p.label} w > 0`);
    assert(p.targetBbox.h > 0, `${p.label} h > 0`);
  }
});

await test("クロップ結果のバッファをsharpで読み込める", async () => {
  const layers = [
    { label: "readable", category: "icon", bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, zIndex: 0 },
  ];

  const cropped = await cropLayers(TEST_IMAGE, layers);
  const meta = await sharp(cropped[0].imageBuffer).metadata();
  assert(
    meta.width === cropped[0].pixelWidth,
    `Width mismatch: meta=${meta.width}, cropped=${cropped[0].pixelWidth}`,
  );
  assert(
    meta.height === cropped[0].pixelHeight,
    `Height mismatch: meta=${meta.height}, cropped=${cropped[0].pixelHeight}`,
  );
});

await test("クロップ→配置→JSON変換が正しく動く（Geminiへの入力準備）", async () => {
  const meta = await getImageMetadata(TEST_IMAGE);
  const layers = [
    { label: "main_card", category: "card", bbox: { x: 0.1, y: 0.15, w: 0.5, h: 0.7 }, zIndex: 0 },
    { label: "logo", category: "logo", bbox: { x: 0.7, y: 0.05, w: 0.2, h: 0.1 }, zIndex: 1 },
  ];

  const cropped = await cropLayers(TEST_IMAGE, layers);
  const placements = computeLayerPlacements(cropped, meta.width, meta.height, 1080, 1920);

  // JSON.stringifyが正常に動くこと
  const json = JSON.stringify(placements, null, 2);
  const parsed = JSON.parse(json);
  assert(parsed.length === 2, "Should serialize/deserialize 2 placements");
  assert(parsed[0].label === "main_card", "First placement label");
  assert(parsed[1].label === "logo", "Second placement label");
  assert(typeof parsed[0].targetBbox.x === "number", "targetBbox.x should be number");
});

// ─── [4] MCP経由テスト - layeredRecompose パス ───

console.log("\n[4] MCP経由テスト - layeredRecompose パス");

await test("outpaint戦略が layeredRecompose を経由する（GCPエラーで確認）", async () => {
  const { result, stderr } = await callToolMcp("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "meta",
    size_name: "landscape",
    output_dir: OUTPUT_DIR,
  });
  // GCP認証なしの場合エラーになる
  assert(result.isError === true, "Should error without GCP");
  const text = result.content[0].text;
  assert(
    text.includes("GOOGLE_CLOUD_PROJECT") || text.includes("エラー"),
    `Should mention GCP error: ${text}`,
  );
});

await test("stories_reels (9:16) も outpaint→layeredRecompose パスを通る", async () => {
  const { result } = await callToolMcp("resize_banner", {
    image_path: TEST_IMAGE,
    platform: "meta",
    size_name: "stories_reels",
    output_dir: OUTPUT_DIR,
  });
  assert(result.isError === true, "Should error without GCP");
});

// ─── Summary ───

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log("=".repeat(50) + "\n");

// Cleanup
rmSync(OUTPUT_DIR, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
