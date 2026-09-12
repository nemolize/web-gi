import { expect, test, vi } from "vitest";

import { createComparisonSession } from "@/gi/comparison-session";
import { GiRenderer } from "@/gi/renderer";
import { DEFAULT_SETTINGS } from "@/gi/settings";

const pendingRenderer = () => {
  const renderer = Object.create(GiRenderer.prototype);
  Object.assign(renderer, {
    settings: { ...DEFAULT_SETTINGS, restirMethod: "bdpt" },
    bdptFrameActive: true,
    bdptDeferredSettings: null,
    comparisonGeneration: 0,
    comparisonInProgress: false,
    comparisonAbortController: null,
    comparisonReadinessController: null,
    targets: null,
    accumFrames: 3,
    historyFrames: 3,
  });
  const image = { width: 1, height: 1, data: new Float32Array([1, 1, 1, 1]) };
  const capture = vi.fn(async () => image);
  const captureWindow = vi.fn(async () => null);
  const captureFrames = vi.fn(async (frames) => ({
    image,
    actualDurationMs: 1,
    frames,
  }));
  renderer.comparisonSession = createComparisonSession(
    capture,
    captureWindow,
    captureFrames,
    () => ({
      mode: renderer.settings.mode,
      referenceKey: "same-scene-camera-size",
      runKey: renderer.settings.mode,
      accumFrames: renderer.accumFrames,
      details: {},
    }),
  );
  let release;
  renderer.bdptPresentation = new Promise((resolve) => {
    release = resolve;
  }).then(() => {
    renderer.bdptFrameActive = false;
    const settings = renderer.bdptDeferredSettings;
    renderer.bdptDeferredSettings = null;
    if (settings) renderer.setSettings(settings);
    renderer.bdptPresentation = null;
  });
  return { renderer, capture, captureFrames, captureWindow, release };
};

test.each(["saveComparisonReference", "saveComparisonReferenceAfterFrames"])(
  "%s waits for a pending tiled frame before checking the selected mode",
  async (method) => {
    const { renderer, capture, captureFrames, release } = pendingRenderer();
    renderer.setSettings({ ...renderer.settings, mode: "reference" });
    expect(renderer.settings.mode).toBe("restir");
    let settled = false;
    const saved = renderer[method](2).then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(captureFrames).not.toHaveBeenCalled();
    release();
    expect(await saved).toBe(true);
    expect(renderer.settings.mode).toBe("reference");
    if (method === "saveComparisonReference") {
      expect(capture).toHaveBeenCalledOnce();
    } else {
      expect(captureFrames).toHaveBeenCalledWith(2);
    }
  },
);

test("timed comparison waits before capturing its renderer context", async () => {
  const { renderer, captureWindow, release } = pendingRenderer();
  renderer.settings = { ...renderer.settings, mode: "reference" };
  await renderer.comparisonSession.saveReference();
  renderer.settings = { ...renderer.settings, mode: "restir" };
  renderer.setSettings({ ...renderer.settings, mode: "path-traced" });
  const compared = renderer.compareReferenceAfter("path-traced", 10);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  expect(captureWindow).not.toHaveBeenCalled();
  release();
  expect(await compared).toBeNull();
  expect(captureWindow).toHaveBeenCalledWith(10);
  expect(renderer.settings.mode).toBe("path-traced");
});

test("cancelling reference readiness rejects before the pending tile completes", async () => {
  const { renderer, capture, captureFrames, release } = pendingRenderer();
  renderer.setSettings({ ...renderer.settings, mode: "reference" });
  const saved = renderer.saveComparisonReferenceAfterFrames(2);
  const rejected = expect(saved).rejects.toThrow("Cancelled while waiting");
  renderer.cancelComparison("Cancelled while waiting");
  await rejected;
  expect(renderer.bdptFrameActive).toBe(true);
  expect(renderer.comparisonReadinessController).toBeNull();
  expect(captureFrames).not.toHaveBeenCalled();
  release();
  await renderer.bdptPresentation;
  expect(capture).not.toHaveBeenCalled();
  expect(captureFrames).not.toHaveBeenCalled();
});
