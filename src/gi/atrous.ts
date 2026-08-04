export const DEFAULT_WORKGROUP_SIZE = 8;
export const ATROUS_ITERATIONS = 3;
export const ATROUS_KERNEL_RADIUS = 2;
export const TILED_ATROUS_WORKGROUP_SIZE = 16;
export const TILED_ATROUS_HALO =
  ATROUS_KERNEL_RADIUS * (1 << (ATROUS_ITERATIONS - 1));
export const TILED_ATROUS_TILE_WIDTH =
  TILED_ATROUS_WORKGROUP_SIZE + 2 * TILED_ATROUS_HALO;

// 32x32 texels: f32 depth (4 B), packed rgba16float normal (8 B), and
// three f32 colour channels (12 B). The first input is rgba32float history,
// so packing colour to f16 would change the filter rather than only its cache.
export const TILED_ATROUS_STORAGE_BYTES =
  TILED_ATROUS_TILE_WIDTH * TILED_ATROUS_TILE_WIDTH * (4 + 8 + 12);

export type AtrousLimits = Pick<
  GPUSupportedLimits,
  | "maxComputeInvocationsPerWorkgroup"
  | "maxComputeWorkgroupSizeX"
  | "maxComputeWorkgroupSizeY"
  | "maxComputeWorkgroupStorageSize"
>;

export const supportsTiledAtrous = (limits: AtrousLimits): boolean =>
  limits.maxComputeInvocationsPerWorkgroup >=
    TILED_ATROUS_WORKGROUP_SIZE * TILED_ATROUS_WORKGROUP_SIZE &&
  limits.maxComputeWorkgroupSizeX >= TILED_ATROUS_WORKGROUP_SIZE &&
  limits.maxComputeWorkgroupSizeY >= TILED_ATROUS_WORKGROUP_SIZE &&
  limits.maxComputeWorkgroupStorageSize >= TILED_ATROUS_STORAGE_BYTES;

/** `?atrous=fallback` keeps preview A/B measurements on one deployment. */
export const selectTiledAtrous = (
  limits: AtrousLimits,
  search: string,
): boolean =>
  supportsTiledAtrous(limits) &&
  new URLSearchParams(search).get("atrous") !== "fallback";
