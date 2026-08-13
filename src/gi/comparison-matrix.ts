import type { OrbitCamera } from "@/gi/camera";
import { DEFAULT_CAMERA } from "@/gi/camera";
import type { LinearComparisonReport } from "@/gi/comparison-session";
import type { SceneVariant } from "@/gi/scene";
import type { ComparisonMode } from "@/gi/settings";

export const COMPARISON_MATRIX_MODES = [
  "restir",
  "path-traced",
] as const satisfies readonly ComparisonMode[];

export const COMPARISON_MATRIX_RUN_ORDERS = [
  COMPARISON_MATRIX_MODES,
  ["path-traced", "restir"],
] as const satisfies readonly (readonly [ComparisonMode, ComparisonMode])[];

const COMPARISON_MATRIX_CAMERAS = [
  { label: "front", camera: DEFAULT_CAMERA },
  {
    label: "left",
    camera: { ...DEFAULT_CAMERA, yaw: 0.4 },
  },
  {
    label: "right-high",
    camera: { ...DEFAULT_CAMERA, yaw: -0.4, pitch: 0.2 },
  },
] as const satisfies readonly {
  readonly label: string;
  readonly camera: OrbitCamera;
}[];

const COMPARISON_MATRIX_SCENES = [
  "classic",
  "manyLights",
] as const satisfies readonly SceneVariant[];

export type ComparisonMatrixCase = {
  readonly label: string;
  readonly scene: SceneVariant;
  readonly cameraLabel: string;
  readonly cameraIndex: number;
  readonly camera: OrbitCamera;
};

export const COMPARISON_MATRIX_CASES: readonly ComparisonMatrixCase[] =
  COMPARISON_MATRIX_SCENES.flatMap((scene) =>
    COMPARISON_MATRIX_CAMERAS.map(
      ({ label: cameraLabel, camera }, cameraIndex) => ({
        label: `${scene}/${cameraLabel}`,
        scene,
        cameraLabel,
        cameraIndex,
        camera,
      }),
    ),
  );

/** Even, so every case gets each run order exactly half the time. */
export const DEFAULT_COMPARISON_MATRIX_REPEATS = 4;

export type ComparisonMatrixRun = ComparisonMatrixCase & {
  /** 0-based. */
  readonly repeat: number;
  readonly runOrder: readonly [ComparisonMode, ComparisonMode];
};

/**
 * Even: run order flips with `repeat`, so an odd stride would flip each case's
 * sweep-position parity in step with it and lock position to run order.
 */
const ROTATION_STRIDE = 2;

/**
 * Repeats outermost, each rotating the case order so a scene does not sit at the
 * same point of every sweep. Run order alternates on `cameraIndex + repeat`,
 * balanced per scene at an even repeat count.
 */
export const comparisonMatrixRuns = (
  repeats: number,
): readonly ComparisonMatrixRun[] =>
  Array.from({ length: Math.max(1, Math.trunc(repeats)) }, (_, repeat) => {
    const offset = (repeat * ROTATION_STRIDE) % COMPARISON_MATRIX_CASES.length;
    return [
      ...COMPARISON_MATRIX_CASES.slice(offset),
      ...COMPARISON_MATRIX_CASES.slice(0, offset),
    ].map((entry) => ({
      ...entry,
      repeat,
      runOrder:
        (entry.cameraIndex + repeat) % 2 === 0
          ? COMPARISON_MATRIX_RUN_ORDERS[0]
          : COMPARISON_MATRIX_RUN_ORDERS[1],
    }));
  }).flat();

export type ComparisonMatrixRunReport = ComparisonMatrixRun & {
  readonly comparisons: Readonly<
    Record<ComparisonMode, LinearComparisonReport>
  >;
};

export type LinearComparisonMatrixReport = {
  readonly kind: "comparison-matrix";
  readonly requestedReferenceFrames: number;
  readonly requestedDurationMs: number;
  readonly repeats: number;
  readonly runs: readonly ComparisonMatrixRunReport[];
};

export type ComparisonMatrixProgress = {
  readonly runIndex: number;
  readonly totalRuns: number;
  readonly entry: ComparisonMatrixRun;
  readonly phase: "reference" | ComparisonMode;
};
