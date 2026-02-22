export type PlatformId = "google_ads" | "meta" | "yahoo_japan" | "line";

export interface BannerSize {
  name: string;
  width: number;
  height: number;
  aspectRatio: string;
}

export interface PlatformConfig {
  id: PlatformId;
  displayName: string;
  sizes: BannerSize[];
}

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  channels: number;
}

export type ResizeStrategy = "resize" | "smart_crop" | "outpaint";

export interface ResizeResult {
  outputPath: string;
  width: number;
  height: number;
  strategy: ResizeStrategy;
  platform: PlatformId;
  sizeName: string;
}

export interface OutpaintCanvasResult {
  paddedImageBuffer: Buffer;
  maskBuffer: Buffer;
  canvasWidth: number;
  canvasHeight: number;
}

/** レイヤー分解で検出されたバウンディングボックス（正規化座標 0.0–1.0） */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Geminiテキストモードで検出された1レイヤー */
export interface DetectedLayer {
  label: string;
  category: "text" | "logo" | "card" | "icon" | "decoration" | "product" | "other";
  bbox: BBox;
  zIndex: number;
}

/** クロップ済みレイヤー（元ピクセルそのまま） */
export interface CroppedLayer {
  detection: DetectedLayer;
  imageBuffer: Buffer;
  pixelWidth: number;
  pixelHeight: number;
}

/** 再配置時のレイヤー配置情報（ターゲット座標系、正規化座標 0.0–1.0） */
export interface LayerPlacement {
  label: string;
  targetBbox: BBox;
}
