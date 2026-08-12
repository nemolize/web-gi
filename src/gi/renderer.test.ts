import { describe, expect, it, vi } from "vitest";

import { runCompletionBatches } from "@/gi/renderer";

describe("reference completion batching", () => {
  it("renders exact partial batches and drains once per batch", async () => {
    let completedFrames = 0;
    const waits: number[] = [];
    const validations: number[] = [];

    const completed = await runCompletionBatches(5, 4, {
      getFrameCount: () => completedFrames,
      renderFrame: () => {
        completedFrames += 1;
      },
      waitForSubmittedWork: () => {
        waits.push(completedFrames);
        return Promise.resolve();
      },
      validateAfterWait: () => validations.push(completedFrames),
    });

    expect(completed).toBe(true);
    expect(completedFrames).toBe(5);
    expect(waits).toEqual([4, 5]);
    expect(validations).toEqual([4, 5]);
  });

  it("stops without draining when rendering cannot advance", async () => {
    const waitForSubmittedWork = vi.fn(() => Promise.resolve());

    const completed = await runCompletionBatches(1, 4, {
      getFrameCount: () => 0,
      renderFrame: () => undefined,
      waitForSubmittedWork,
      validateAfterWait: () => undefined,
    });

    expect(completed).toBe(false);
    expect(waitForSubmittedWork).not.toHaveBeenCalled();
  });

  it("drains submitted work before returning from a partial stalled batch", async () => {
    let frameCount = 0;
    const waits: number[] = [];

    const completed = await runCompletionBatches(4, 4, {
      getFrameCount: () => frameCount,
      renderFrame: () => {
        if (frameCount < 2) frameCount += 1;
      },
      waitForSubmittedWork: () => {
        waits.push(frameCount);
        return Promise.resolve();
      },
      validateAfterWait: () => undefined,
    });

    expect(completed).toBe(false);
    expect(waits).toEqual([2]);
  });
});
