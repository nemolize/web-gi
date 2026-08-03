/**
 * Development-only handle for the linear-capture instrumentation. Vite strips
 * the installer's body from a production build, so this costs the shipped
 * bundle nothing — the capture has no user-facing surface and exists to let a
 * measurement harness read the render back and score it against the reference.
 */
import type { LinearImage } from "@/gi/compare";
import { compareLinear } from "@/gi/compare";

export type DevHooks = {
  readonly capture: () => Promise<LinearImage | null>;
  readonly compare: typeof compareLinear;
};

declare global {
  var __gi: DevHooks | undefined;
}

export const installDevHooks = (
  capture: () => Promise<LinearImage | null>,
): void => {
  if (!import.meta.env.DEV) return;
  globalThis.__gi = { capture, compare: compareLinear };
};
