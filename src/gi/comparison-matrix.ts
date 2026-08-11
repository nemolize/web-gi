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
  readonly camera: OrbitCamera;
};

export const COMPARISON_MATRIX_CASES: readonly ComparisonMatrixCase[] =
  COMPARISON_MATRIX_SCENES.flatMap((scene) =>
    COMPARISON_MATRIX_CAMERAS.map(({ label: cameraLabel, camera }) => ({
      label: `${scene}/${cameraLabel}`,
      scene,
      cameraLabel,
      camera,
    })),
  );

export type ComparisonMatrixCaseReport = ComparisonMatrixCase & {
  readonly runOrder: readonly [ComparisonMode, ComparisonMode];
  readonly comparisons: Readonly<
    Record<ComparisonMode, LinearComparisonReport>
  >;
};

export type LinearComparisonMatrixReport = {
  readonly kind: "comparison-matrix";
  readonly requestedReferenceFrames: number;
  readonly requestedDurationMs: number;
  readonly cases: readonly ComparisonMatrixCaseReport[];
};

export type ComparisonMatrixProgress = {
  readonly caseIndex: number;
  readonly totalCases: number;
  readonly entry: ComparisonMatrixCase;
  readonly phase: "reference" | ComparisonMode;
};
