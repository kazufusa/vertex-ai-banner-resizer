import { PlatformConfig, PlatformId } from "../types/index.js";

export const PLATFORM_CONFIGS: Record<PlatformId, PlatformConfig> = {
  google_ads: {
    id: "google_ads",
    displayName: "Google Ads (Responsive Display)",
    sizes: [
      { name: "landscape", width: 1200, height: 628, aspectRatio: "1.91:1" },
      { name: "square", width: 1200, height: 1200, aspectRatio: "1:1" },
      { name: "portrait", width: 1200, height: 1500, aspectRatio: "4:5" },
    ],
  },
  meta: {
    id: "meta",
    displayName: "Meta (Facebook/Instagram)",
    sizes: [
      { name: "feed_square", width: 1080, height: 1080, aspectRatio: "1:1" },
      {
        name: "feed_vertical",
        width: 1080,
        height: 1350,
        aspectRatio: "4:5",
      },
      {
        name: "stories_reels",
        width: 1080,
        height: 1920,
        aspectRatio: "9:16",
      },
      { name: "landscape", width: 1200, height: 628, aspectRatio: "1.91:1" },
    ],
  },
  yahoo_japan: {
    id: "yahoo_japan",
    displayName: "Yahoo Japan (YDA)",
    sizes: [
      {
        name: "responsive_landscape",
        width: 2400,
        height: 1256,
        aspectRatio: "~1.91:1",
      },
      {
        name: "responsive_square",
        width: 1200,
        height: 1200,
        aspectRatio: "1:1",
      },
      { name: "banner", width: 600, height: 500, aspectRatio: "6:5" },
    ],
  },
  line: {
    id: "line",
    displayName: "LINE",
    sizes: [
      { name: "card", width: 1200, height: 628, aspectRatio: "~1.91:1" },
      { name: "square", width: 1080, height: 1080, aspectRatio: "1:1" },
      { name: "small", width: 600, height: 400, aspectRatio: "3:2" },
    ],
  },
};

export function getPlatformConfig(
  platformId: PlatformId,
): PlatformConfig | undefined {
  return PLATFORM_CONFIGS[platformId];
}

export function getBannerSize(
  platformId: PlatformId,
  sizeName: string,
): { platform: PlatformConfig; size: (typeof PLATFORM_CONFIGS)[PlatformId]["sizes"][number] } | undefined {
  const platform = PLATFORM_CONFIGS[platformId];
  if (!platform) return undefined;
  const size = platform.sizes.find((s) => s.name === sizeName);
  if (!size) return undefined;
  return { platform, size };
}

export function getAllPlatformIds(): PlatformId[] {
  return Object.keys(PLATFORM_CONFIGS) as PlatformId[];
}
