import type { SceneVariant } from "@/gi/scene";

export const RENDER_MODES = ["restir", "path-traced", "reference"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

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
 * absent: every surface is Lambertian, so accumulated irradiance stays valid
 * when the eye moves and only the reference path tracer needs a reset.
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
