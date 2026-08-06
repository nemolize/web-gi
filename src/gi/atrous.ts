export const DEFAULT_WORKGROUP_SIZE = 8;
export const ATROUS_ITERATIONS = 3;
export const ATROUS_KERNEL_RADIUS = 2;
export const ATROUS_HALO =
  ATROUS_KERNEL_RADIUS * (1 << (ATROUS_ITERATIONS - 1));
export const LARGE_TILED_ATROUS_WORKGROUP_SIZE = 16;
export const BASELINE_TILED_ATROUS_WORKGROUP_SIZE = 8;

const tileWidth = (workgroupSize: number): number =>
  workgroupSize + 2 * ATROUS_HALO;

export const LARGE_TILED_ATROUS_TILE_WIDTH = tileWidth(
  LARGE_TILED_ATROUS_WORKGROUP_SIZE,
);
export const BASELINE_TILED_ATROUS_TILE_WIDTH = tileWidth(
  BASELINE_TILED_ATROUS_WORKGROUP_SIZE,
);

// Each texel stores f32 depth (4 B), packed rgba16float normal (8 B), and
// three f32 colour channels (12 B). The first input is rgba32float history,
// so packing colour to f16 would change the filter rather than only its cache.
const TILED_ATROUS_BYTES_PER_TEXEL = 4 + 8 + 12;
export const LARGE_TILED_ATROUS_STORAGE_BYTES =
  LARGE_TILED_ATROUS_TILE_WIDTH ** 2 * TILED_ATROUS_BYTES_PER_TEXEL;
export const BASELINE_TILED_ATROUS_STORAGE_BYTES =
  BASELINE_TILED_ATROUS_TILE_WIDTH ** 2 * TILED_ATROUS_BYTES_PER_TEXEL;

export const ATROUS_VARIANTS = ["tiled-16", "tiled-8", "fallback"] as const;
export type AtrousVariant = (typeof ATROUS_VARIANTS)[number];

export type AtrousLimits = Pick<
  GPUSupportedLimits,
  | "maxComputeInvocationsPerWorkgroup"
  | "maxComputeWorkgroupSizeX"
  | "maxComputeWorkgroupSizeY"
  | "maxComputeWorkgroupStorageSize"
>;

const supportsTiledAtrous = (
  limits: AtrousLimits,
  workgroupSize: number,
  storageBytes: number,
): boolean =>
  limits.maxComputeInvocationsPerWorkgroup >= workgroupSize * workgroupSize &&
  limits.maxComputeWorkgroupSizeX >= workgroupSize &&
  limits.maxComputeWorkgroupSizeY >= workgroupSize &&
  limits.maxComputeWorkgroupStorageSize >= storageBytes;

export const supportsLargeTiledAtrous = (limits: AtrousLimits): boolean =>
  supportsTiledAtrous(
    limits,
    LARGE_TILED_ATROUS_WORKGROUP_SIZE,
    LARGE_TILED_ATROUS_STORAGE_BYTES,
  );

export const supportsBaselineTiledAtrous = (limits: AtrousLimits): boolean =>
  supportsTiledAtrous(
    limits,
    BASELINE_TILED_ATROUS_WORKGROUP_SIZE,
    BASELINE_TILED_ATROUS_STORAGE_BYTES,
  );

/** Query overrides keep all three preview A/B paths on one deployment. */
export const selectAtrousVariant = (
  limits: AtrousLimits,
  search: string,
): AtrousVariant => {
  const requested = new URLSearchParams(search).get("atrous");
  if (requested === "fallback") return "fallback";
  if (requested === "8" && supportsBaselineTiledAtrous(limits)) {
    return "tiled-8";
  }
  if (requested !== "8" && supportsLargeTiledAtrous(limits)) {
    return "tiled-16";
  }
  return "fallback";
};

const ATROUS_WORKGROUP_SIZES = {
  "tiled-16": LARGE_TILED_ATROUS_WORKGROUP_SIZE,
  "tiled-8": BASELINE_TILED_ATROUS_WORKGROUP_SIZE,
  fallback: DEFAULT_WORKGROUP_SIZE,
} as const satisfies Record<AtrousVariant, number>;

export const atrousWorkgroupSize = (variant: AtrousVariant): number =>
  ATROUS_WORKGROUP_SIZES[variant];
