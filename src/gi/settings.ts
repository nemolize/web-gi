import type { SceneVariant } from "@/gi/scene";

export const RENDER_MODES = ["restir", "path-traced", "reference"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];
export const COMPARISON_MODES = ["restir", "path-traced"] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];
export const MATRIX_PRESETS = ["matrix", "probe"] as const;
export type MatrixPreset = (typeof MATRIX_PRESETS)[number];
export type AutoComparisonMode = ComparisonMode | MatrixPreset;

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

/**
 * Allowlisted, not parsed: an unrecognised value must drop out of the recorded
 * `url` rather than round to one nobody chose (#80).
 */
export const MATRIX_RESOLUTION_SCALES = [
  "0.25",
  "0.3",
  "0.35",
  "0.4",
  "0.5",
  "0.6",
  "0.75",
  "1",
] as const;

/** Spans the range the panel offers, to test the pixel-unit radius of #90. */
export const MATRIX_SPATIAL_RADII = [
  "2",
  "4",
  "6",
  "8",
  "12",
  "16",
  "24",
  "32",
  "48",
  "64",
] as const;

/** `0` degenerates both spatial passes to 1/Z pass-through, separating spatial
 * reuse from temporal reprojection as the cause of #90's grazing cases. */
export const MATRIX_SPATIAL_SAMPLES = ["0", "1", "2", "4", "8"] as const;

type NumericSettingKey = {
  [K in keyof RenderSettings]: RenderSettings[K] extends number ? K : never;
}[keyof RenderSettings];

/** `key` is numeric-only: the value reaches settings through `Number()`. */
const MATRIX_OVERRIDES = [
  { param: "scale", key: "resolutionScale", values: MATRIX_RESOLUTION_SCALES },
  { param: "radius", key: "spatialRadius", values: MATRIX_SPATIAL_RADII },
  { param: "spatial", key: "spatialSamples", values: MATRIX_SPATIAL_SAMPLES },
] as const satisfies readonly {
  readonly param: string;
  readonly key: NumericSettingKey;
  readonly values: readonly string[];
}[];

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
  const matrix = enumValue(source, "preset", MATRIX_PRESETS);
  if (matrix !== undefined) {
    sanitized.set("preset", matrix);
    for (const { param, values } of MATRIX_OVERRIDES) {
      const value = enumValue(source, param, values);
      if (value !== undefined) sanitized.set(param, value);
    }
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
    preset === null
      ? { ...DEFAULT_SETTINGS }
      : { ...DEFAULT_SETTINGS, ...HEAVY_SETTINGS };
  const overrides = Object.fromEntries(
    MATRIX_OVERRIDES.flatMap(({ param, key }) => {
      const value = params.get(param);
      return value === null ? [] : [[key, Number(value)]];
    }),
  );
  return {
    ...base,
    ...overrides,
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
  return (
    enumValue(params, "preset", MATRIX_PRESETS) ??
    enumValue(params, "compare", COMPARISON_MODES) ??
    null
  );
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
