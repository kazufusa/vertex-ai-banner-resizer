import sharp from "sharp";
import {
  CroppedLayer,
  DetectedLayer,
  ImageMetadata,
  LayerPlacement,
  OutpaintCanvasResult,
  ResizeStrategy,
} from "../types/index.js";

/**
 * 画像のメタデータを取得する
 */
export async function getImageMetadata(
  imagePath: string,
): Promise<ImageMetadata> {
  const metadata = await sharp(imagePath).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new Error(`画像メタデータの取得に失敗しました: ${imagePath}`);
  }
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    channels: metadata.channels ?? 3,
  };
}

/**
 * アスペクト比の差異に基づいてリサイズ戦略を決定する
 */
export function determineStrategy(
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  targetHeight: number,
): ResizeStrategy {
  const srcRatio = srcWidth / srcHeight;
  const targetRatio = targetWidth / targetHeight;
  const ratioDiff = Math.abs(srcRatio - targetRatio) / targetRatio;

  if (ratioDiff < 0.02) {
    // アスペクト比がほぼ同じ（2%以内）→ リサイズのみ
    return "resize";
  } else if (ratioDiff < 0.20) {
    // アスペクト比が近い（20%以内）→ スマートクロップ
    return "smart_crop";
  } else {
    // アスペクト比が大きく異なる → outpainting
    return "outpaint";
  }
}

/**
 * 高品質リサイズ（Lanczos3）
 */
export async function resizeToExact(
  input: string | Buffer,
  width: number,
  height: number,
  outputPath: string,
): Promise<void> {
  await sharp(input)
    .resize(width, height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toFile(outputPath);
}

/**
 * attention-based スマートクロップ + リサイズ
 */
export async function smartCrop(
  imagePath: string,
  targetWidth: number,
  targetHeight: number,
  outputPath: string,
): Promise<void> {
  await sharp(imagePath)
    .resize(targetWidth, targetHeight, {
      fit: "cover",
      position: sharp.strategy.attention,
    })
    .png()
    .toFile(outputPath);
}

/**
 * outpainting用のキャンバスとマスクを生成する
 *
 * 入力画像をターゲットアスペクト比のキャンバス中央に配置し、
 * 余白部分を示すマスク画像を生成する
 */
export async function createOutpaintCanvas(
  imagePath: string,
  targetWidth: number,
  targetHeight: number,
): Promise<OutpaintCanvasResult> {
  const metadata = await getImageMetadata(imagePath);
  const srcWidth = metadata.width;
  const srcHeight = metadata.height;

  // ターゲットアスペクト比に合わせたキャンバスサイズを計算
  // 元画像がキャンバス内に収まるようにスケーリング
  const targetRatio = targetWidth / targetHeight;
  let canvasWidth: number;
  let canvasHeight: number;

  if (srcWidth / srcHeight > targetRatio) {
    // 元画像の方が横長 → 幅基準
    canvasWidth = srcWidth;
    canvasHeight = Math.round(srcWidth / targetRatio);
  } else {
    // 元画像の方が縦長 → 高さ基準
    canvasHeight = srcHeight;
    canvasWidth = Math.round(srcHeight * targetRatio);
  }

  // キャンバスサイズが偶数になるよう調整（AIモデルの要件）
  canvasWidth = canvasWidth % 2 === 0 ? canvasWidth : canvasWidth + 1;
  canvasHeight = canvasHeight % 2 === 0 ? canvasHeight : canvasHeight + 1;

  // 元画像のキャンバス上の配置位置（中央配置）
  const offsetX = Math.round((canvasWidth - srcWidth) / 2);
  const offsetY = Math.round((canvasHeight - srcHeight) / 2);

  // パディング済み画像を作成（余白は白で塗りつぶし）
  const paddedImageBuffer = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: await sharp(imagePath).toBuffer(),
        left: offsetX,
        top: offsetY,
      },
    ])
    .png()
    .toBuffer();

  // マスク画像を作成（Imagen 3仕様: 白=生成領域、黒=保持領域）
  // まず全体を白（生成領域）で作成
  const maskBase = sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  // 元画像の領域を黒（保持領域）で塗りつぶし
  const blackRect = await sharp({
    create: {
      width: srcWidth,
      height: srcHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();

  const maskBuffer = await maskBase
    .composite([
      {
        input: blackRect,
        left: offsetX,
        top: offsetY,
      },
    ])
    .png()
    .toBuffer();

  return {
    paddedImageBuffer,
    maskBuffer,
    canvasWidth,
    canvasHeight,
  };
}

/**
 * 入力画像のバッファを取得する（base64エンコード用）
 */
export async function getImageBuffer(imagePath: string): Promise<Buffer> {
  return sharp(imagePath).png().toBuffer();
}

/**
 * 検出されたレイヤーを元画像からクロップする
 *
 * 正規化座標→ピクセル座標に変換し、5%パディングを追加して切り出す
 */
export async function cropLayers(
  imagePath: string,
  layers: DetectedLayer[],
): Promise<CroppedLayer[]> {
  const metadata = await getImageMetadata(imagePath);
  const imgW = metadata.width;
  const imgH = metadata.height;
  const PADDING = 0.05; // 5%パディング

  const results: CroppedLayer[] = [];

  for (const layer of layers) {
    // 正規化座標→ピクセル座標（パディング付き）
    const rawLeft = layer.bbox.x * imgW;
    const rawTop = layer.bbox.y * imgH;
    const rawW = layer.bbox.w * imgW;
    const rawH = layer.bbox.h * imgH;

    const padX = rawW * PADDING;
    const padY = rawH * PADDING;

    let left = Math.round(Math.max(0, rawLeft - padX));
    let top = Math.round(Math.max(0, rawTop - padY));
    let width = Math.round(Math.min(imgW - left, rawW + padX * 2));
    let height = Math.round(Math.min(imgH - top, rawH + padY * 2));

    // 最小サイズ保証
    width = Math.max(1, width);
    height = Math.max(1, height);

    // 画像境界内に収める
    if (left + width > imgW) width = imgW - left;
    if (top + height > imgH) height = imgH - top;

    try {
      const imageBuffer = await sharp(imagePath)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();

      results.push({
        detection: layer,
        imageBuffer,
        pixelWidth: width,
        pixelHeight: height,
      });
    } catch (error) {
      console.error(
        `[image-processor] レイヤー "${layer.label}" のクロップに失敗: ${error}`,
      );
      // クロップ失敗は無視して続行
    }
  }

  return results;
}

/**
 * 元画像の配置比率を維持しつつ、ターゲットサイズでのレイヤー配置を計算する
 *
 * 各要素の中心位置を比率で維持し、サイズはそのまま（正規化座標で返す）
 */
export function computeLayerPlacements(
  croppedLayers: CroppedLayer[],
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): LayerPlacement[] {
  return croppedLayers.map((layer) => {
    const det = layer.detection;

    // 元画像での中心位置（正規化座標）
    const centerX = det.bbox.x + det.bbox.w / 2;
    const centerY = det.bbox.y + det.bbox.h / 2;

    // ターゲットでのサイズ（ピクセル比率を維持）
    // 元画像のピクセルサイズ → ターゲット画像での正規化サイズ
    const layerPixelW = det.bbox.w * srcW;
    const layerPixelH = det.bbox.h * srcH;
    const targetNormW = layerPixelW / targetW;
    const targetNormH = layerPixelH / targetH;

    // 中心位置を維持しつつ、はみ出し防止
    const newX = clampCoord(centerX - targetNormW / 2, 0, 1 - targetNormW);
    const newY = clampCoord(centerY - targetNormH / 2, 0, 1 - targetNormH);

    return {
      label: det.label,
      targetBbox: {
        x: newX,
        y: newY,
        w: Math.min(targetNormW, 1),
        h: Math.min(targetNormH, 1),
      },
    };
  });
}

function clampCoord(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * クロップ済みレイヤーにフェザリング（エッジぼかし）アルファを適用する
 *
 * 中央は完全不透明、エッジに向かって徐々に透明になるグラデーションを付与し、
 * 背景との自然な馴染みを実現する
 */
async function addFeatheredAlpha(
  buffer: Buffer,
  featherPx: number,
): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  const w = meta.width!;
  const h = meta.height!;

  // フェザリングが画像サイズの半分を超えないよう制限
  const f = Math.min(featherPx, Math.floor(w / 2), Math.floor(h / 2));
  if (f < 1) {
    // フェザリング不要 — アルファだけ追加して返す
    return sharp(buffer).ensureAlpha().png().toBuffer();
  }

  const innerW = Math.max(1, w - f * 2);
  const innerH = Math.max(1, h - f * 2);

  // 黒背景に白矩形 → ぼかし → アルファマスクとして使う
  const mask = await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: innerW,
            height: innerH,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
        left: f,
        top: f,
      },
    ])
    .blur(Math.max(0.5, f))
    .png()
    .toBuffer();

  // dest-in: マスクの不透明度で元画像をクリップ
  return sharp(buffer)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

/**
 * 拡張済み背景にクロップ済みレイヤーを再配置して合成する
 *
 * computeLayerPlacements() で算出された新位置にレイヤーを配置し、
 * 各レイヤーはターゲットサイズに合わせてスケーリング、
 * エッジにフェザリングを適用して背景と自然に馴染ませる。
 */
export async function compositeLayersOnBackground(
  backgroundBuffer: Buffer,
  croppedLayers: CroppedLayer[],
  placements: LayerPlacement[],
  targetW: number,
  targetH: number,
): Promise<Buffer> {
  // 背景をターゲットサイズにリサイズ
  const resizedBg = await sharp(backgroundBuffer)
    .resize(targetW, targetH, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();

  // zIndex 昇順にソート（低い=先に配置=下）
  const sorted = croppedLayers
    .map((layer, i) => ({
      layer,
      placement: placements[i],
      zIndex: layer.detection.zIndex,
    }))
    .sort((a, b) => a.zIndex - b.zIndex);

  // composite 用の入力配列を構築
  const compositeInputs: sharp.OverlayOptions[] = [];

  for (const { layer, placement } of sorted) {
    // 配置先のピクセルサイズ
    const placedW = Math.round(placement.targetBbox.w * targetW);
    const placedH = Math.round(placement.targetBbox.h * targetH);

    if (placedW < 1 || placedH < 1) continue;

    // レイヤーをターゲットサイズに合わせてリサイズ
    const resized = await sharp(layer.imageBuffer)
      .resize(placedW, placedH, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();

    // フェザリング（短辺の 8% をぼかし幅とする）
    const featherPx = Math.round(Math.min(placedW, placedH) * 0.08);
    const feathered = await addFeatheredAlpha(resized, featherPx);

    const left = Math.round(placement.targetBbox.x * targetW);
    const top = Math.round(placement.targetBbox.y * targetH);

    compositeInputs.push({
      input: feathered,
      left,
      top,
    });
  }

  // 背景に全レイヤーを合成
  return sharp(resizedBg)
    .composite(compositeInputs)
    .png()
    .toBuffer();
}
