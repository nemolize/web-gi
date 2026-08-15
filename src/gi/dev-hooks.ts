/** Global access to diagnostics in development and explicitly enabled E2E builds. */
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
  if (!import.meta.env.DEV && import.meta.env["VITE_E2E_CAPTURE"] !== "1") {
    return;
  }
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
