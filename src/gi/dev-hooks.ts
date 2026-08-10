/**
 * Development-only handle for the linear-capture instrumentation. Vite strips
 * the installer's body from a production build, so this costs the shipped
 * bundle nothing — the capture has no user-facing surface and exists to let a
 * measurement harness read the render back and score it against the reference.
 */
import type { CameraBasis } from "@/gi/camera";
import type { ComparisonStats, LinearImage } from "@/gi/compare";
import { compareLinear } from "@/gi/compare";
import type { RenderMode, RenderSettings } from "@/gi/settings";

export type CompletionWindowCapture = {
  readonly image: LinearImage;
  readonly actualDurationMs: number;
  readonly frames: number;
};

export type DevComparisonDetails = {
  readonly scene: RenderSettings["scene"];
  readonly maxBounces: number;
  readonly width: number;
  readonly height: number;
  readonly camera: CameraBasis;
  readonly settings: RenderSettings;
};

export type DevComparisonContext = {
  readonly mode: RenderMode;
  /** Scene, camera, resolution, and transport settings shared with the oracle. */
  readonly referenceKey: string;
  /** Full renderer state, used to reject settings changes during a timed run. */
  readonly runKey: string;
  readonly accumFrames: number;
  readonly details: DevComparisonDetails;
};

export type DevComparisonReport = ComparisonStats & {
  readonly label: string;
  readonly mode: Exclude<RenderMode, "reference">;
  readonly requestedDurationMs: number;
  readonly actualDurationMs: number;
  readonly targetFrames: number;
  readonly referenceFrames: number;
  readonly context: DevComparisonDetails;
};

export type DevHooks = {
  readonly capture: () => Promise<LinearImage | null>;
  readonly compare: typeof compareLinear;
  readonly saveReference: () => Promise<boolean>;
  readonly compareReference: (
    label?: string,
  ) => Promise<ComparisonStats | null>;
  readonly compareReferenceAfter: (
    label: string,
    durationMs: number,
  ) => Promise<DevComparisonReport | null>;
};

declare global {
  var __gi: DevHooks | undefined;
}

export const installDevHooks = (
  capture: () => Promise<LinearImage | null>,
  captureAfterCompletionWindow: (
    durationMs: number,
  ) => Promise<CompletionWindowCapture | null>,
  getContext: () => DevComparisonContext | null,
): void => {
  if (!import.meta.env.DEV) return;
  let reference: {
    readonly image: LinearImage;
    readonly key: string;
    readonly frames: number;
  } | null = null;
  let busy = false;

  const exclusively = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error("A comparison operation is already running.");
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  };

  const requireComparableContext = (): DevComparisonContext & {
    readonly mode: Exclude<RenderMode, "reference">;
  } => {
    const context = getContext();
    if (context === null) throw new Error("Render a frame before comparing.");
    if (reference === null) throw new Error("Save a reference first.");
    if (context.mode === "reference") {
      throw new Error("Select ReSTIR or Denoised PT before comparing.");
    }
    if (context.referenceKey !== reference.key) {
      throw new Error("Scene, camera, resolution, or bounce count changed.");
    }
    return { ...context, mode: context.mode };
  };

  const score = (
    current: LinearImage | null,
    label: string,
  ): ComparisonStats | null => {
    if (current === null || reference === null) return null;
    const stats = compareLinear(current, reference.image);
    console.info(`[web-gi] compare ${label}: ${JSON.stringify(stats)}`);
    return stats;
  };

  const compareReference = async (
    label = "render",
  ): Promise<ComparisonStats | null> =>
    exclusively(async () => {
      requireComparableContext();
      const current = await capture();
      return score(current, label);
    });
  globalThis.__gi = {
    capture,
    compare: compareLinear,
    saveReference: () =>
      exclusively(async () => {
        const before = getContext();
        if (before === null) throw new Error("Render a frame before saving.");
        if (before.mode !== "reference") {
          throw new Error("Select Reference PT before saving a reference.");
        }
        const image = await capture();
        const after = getContext();
        if (
          image === null ||
          after === null ||
          after.mode !== "reference" ||
          after.referenceKey !== before.referenceKey
        ) {
          return false;
        }
        reference = {
          image,
          key: before.referenceKey,
          frames: before.accumFrames,
        };
        return true;
      }),
    compareReference,
    compareReferenceAfter: (label, durationMs) =>
      exclusively(async () => {
        const before = requireComparableContext();
        const completed = await captureAfterCompletionWindow(durationMs);
        const after = getContext();
        if (
          after === null ||
          after.referenceKey !== before.referenceKey ||
          after.runKey !== before.runKey
        ) {
          throw new Error("Render settings changed during the comparison.");
        }
        if (completed === null || reference === null) return null;
        const stats = compareLinear(completed.image, reference.image);
        const report: DevComparisonReport = {
          ...stats,
          label,
          mode: before.mode,
          requestedDurationMs: durationMs,
          actualDurationMs: completed.actualDurationMs,
          targetFrames: completed.frames,
          referenceFrames: reference.frames,
          context: before.details,
        };
        console.info(`[web-gi] comparison ${JSON.stringify(report)}`);
        return report;
      }),
  };
};
