import type { SceneVariant } from "@/gi/scene";

export const RENDER_MODES = ["restir", "path-traced", "reference"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];
export const COMPARISON_MODES = ["restir", "path-traced"] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];
export type AutoComparisonMode = ComparisonMode | "matrix";

export type RenderSettings = {
  readonly scene: SceneVariant;
  readonly mode: RenderMode;
  readonly diEnabled: boolean;
  readonly diTemporal: boolean;
  readonly diSpatial: boolean;
  readonly giEnabled: boolean;
  readonly giTemporal: boolean;
  readonly giSpatial: boolean;
  readonly denoise: boolean;
  /** RIS candidates drawn per pixel per frame for direct lighting. */
  readonly diCandidates: number;
  /** Neighbours visited per spatial reuse pass. */
  readonly spatialSamples: number;
  readonly spatialRadius: number;
  /** Bounces traced when evaluating the radiance of a GI sample point. */
  readonly maxBounces: number;
  /** Upper bound on the temporal accumulation window, in frames. */
  readonly maxHistory: number;
  readonly resolutionScale: number;
  readonly exposure: number;
};

export const DEFAULT_SETTINGS: RenderSettings = {
  scene: "classic",
  mode: "restir",
  diEnabled: true,
  diTemporal: true,
  diSpatial: true,
  giEnabled: true,
  giTemporal: true,
  giSpatial: true,
  denoise: true,
  diCandidates: 8,
  spatialSamples: 4,
  spatialRadius: 24,
  maxBounces: 3,
  maxHistory: 512,
  resolutionScale: 0.75,
  exposure: 1,
};

const HEAVY_SETTINGS: Partial<RenderSettings> = {
  scene: "manyLights",
  diCandidates: 32,
  spatialSamples: 8,
  maxBounces: 6,
  resolutionScale: 0.75,
};

const enumValue = <T extends string>(
  params: URLSearchParams,
  key: string,
  values: readonly T[],
): T | undefined => {
  const value = params.get(key);
  return value !== null && values.some((candidate) => candidate === value)
    ? values.find((candidate) => candidate === value)
    : undefined;
};

export const sanitizedRenderQueryParams = (search: string): URLSearchParams => {
  const source = new URLSearchParams(search);
  const sanitized = new URLSearchParams();
  if (source.get("preset") === "matrix") {
    sanitized.set("preset", "matrix");
    return sanitized;
  }
  if (source.get("preset") === "heavy") {
    sanitized.set("preset", "heavy");
  }
  const comparison = enumValue(source, "compare", COMPARISON_MODES);
  if (comparison !== undefined) {
    sanitized.set("compare", comparison);
  } else {
    const mode = enumValue(source, "mode", RENDER_MODES);
    if (mode !== undefined) sanitized.set("mode", mode);
    if (source.get("measure") === "auto") {
      sanitized.set("measure", "auto");
    }
  }
  return sanitized;
};

/** Query settings are initial conditions; panel changes remain session-local. */
export const settingsFromSearch = (search: string): RenderSettings => {
  const params = sanitizedRenderQueryParams(search);
  const preset = params.get("preset");
  const base =
    preset === "heavy" || preset === "matrix"
      ? { ...DEFAULT_SETTINGS, ...HEAVY_SETTINGS }
      : { ...DEFAULT_SETTINGS };
  return {
    ...base,
    mode:
      autoComparisonMode(params) === null
        ? (enumValue(params, "mode", RENDER_MODES) ?? base.mode)
        : "reference",
  };
};

export const shouldAutoMeasure = (search: string): boolean =>
  sanitizedRenderQueryParams(search).get("measure") === "auto";

export const autoComparisonMode = (
  search: string | URLSearchParams,
): AutoComparisonMode | null => {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  if (params.get("preset") === "matrix") return "matrix";
  return enumValue(params, "compare", COMPARISON_MODES) ?? null;
};

export const FLAG_DI_ENABLED = 1 << 0;
export const FLAG_DI_TEMPORAL = 1 << 1;
export const FLAG_DI_SPATIAL = 1 << 2;
export const FLAG_GI_ENABLED = 1 << 3;
export const FLAG_GI_TEMPORAL = 1 << 4;
export const FLAG_GI_SPATIAL = 1 << 5;
export const FLAG_DENOISE = 1 << 6;

export const packFlags = (settings: RenderSettings): number =>
  (settings.diEnabled ? FLAG_DI_ENABLED : 0) |
  (settings.diTemporal ? FLAG_DI_TEMPORAL : 0) |
  (settings.diSpatial ? FLAG_DI_SPATIAL : 0) |
  (settings.giEnabled ? FLAG_GI_ENABLED : 0) |
  (settings.giTemporal ? FLAG_GI_TEMPORAL : 0) |
  (settings.giSpatial ? FLAG_GI_SPATIAL : 0) |
  (settings.denoise ? FLAG_DENOISE : 0);

/**
 * Settings that invalidate accumulated history. Camera motion is deliberately
 * absent: diffuse irradiance survives camera motion. The renderer separately
 * resets view-dependent reference and glass-scene radiance.
 */
const ACCUMULATION_KEYS = [
  "scene",
  "mode",
  "diEnabled",
  "diTemporal",
  "diSpatial",
  "giEnabled",
  "giTemporal",
  "giSpatial",
  "diCandidates",
  "spatialSamples",
  "spatialRadius",
  "maxBounces",
  "resolutionScale",
] as const satisfies readonly (keyof RenderSettings)[];

export const requiresAccumulationReset = (
  previous: RenderSettings,
  next: RenderSettings,
): boolean => ACCUMULATION_KEYS.some((key) => previous[key] !== next[key]);
