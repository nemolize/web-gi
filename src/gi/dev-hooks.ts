/** Development-only global access to the renderer's comparison session. */
import type { LinearImage } from "@/gi/compare";
import { compareLinear } from "@/gi/compare";
import type { ComparisonSession } from "@/gi/comparison-session";
import {
  formatComparisonMatrixSummary,
  summarizeComparisonMatrix,
} from "@/gi/comparison-summary";

export type DevHooks = {
  readonly capture: () => Promise<LinearImage | null>;
  readonly compare: typeof compareLinear;
  readonly saveReference: ComparisonSession["saveReference"];
  readonly compareReference: ComparisonSession["compareReference"];
  readonly compareReferenceAfter: ComparisonSession["compareReferenceAfter"];
  readonly summarizeMatrix: typeof summarizeComparisonMatrix;
  readonly formatMatrixSummary: typeof formatComparisonMatrixSummary;
};

declare global {
  var __gi: DevHooks | undefined;
}

export const installDevHooks = (
  capture: () => Promise<LinearImage | null>,
  comparison: ComparisonSession,
): void => {
  if (!import.meta.env.DEV) return;
  globalThis.__gi = {
    capture,
    compare: compareLinear,
    saveReference: comparison.saveReference,
    compareReference: comparison.compareReference,
    compareReferenceAfter: comparison.compareReferenceAfter,
    summarizeMatrix: summarizeComparisonMatrix,
    formatMatrixSummary: formatComparisonMatrixSummary,
  };
};
