import type { LinearImage } from "@/gi/compare";
import type {
  ComparisonContext,
  CompletionWindowCapture,
} from "@/gi/comparison-session";
import { createComparisonSession } from "@/gi/comparison-session";
import { installDevHooks } from "@/gi/dev-hooks";
import { DEFAULT_SETTINGS, type RenderMode } from "@/gi/settings";

afterEach(() => {
  globalThis.__gi = undefined;
  vi.restoreAllMocks();
});

const image = (value: number): LinearImage => ({
  width: 1,
  height: 1,
  data: new Float32Array([value, value, value, 1]),
});

const comparisonContext = (
  mode: RenderMode,
  runKey: string,
): ComparisonContext => ({
  mode,
  referenceKey: "shared",
  runKey,
  accumFrames: mode === "reference" ? 2_048 : 128,
  details: {
    atrousVariant: "tiled-16",
    scene: "classic",
    maxBounces: 3,
    width: 1,
    height: 1,
    camera: {
      pos: { x: 0, y: 0, z: 2 },
      forward: { x: 0, y: 0, z: -1 },
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      tanHalfFov: 0.25,
      aspect: 1,
    },
    settings: { ...DEFAULT_SETTINGS, mode },
  },
});

const installComparisonHooks = (
  capture: () => Promise<LinearImage | null>,
  captureAfter: (durationMs: number) => Promise<CompletionWindowCapture | null>,
  getContext: () => ComparisonContext | null,
): void => {
  const comparison = createComparisonSession(
    capture,
    captureAfter,
    captureAfter,
    getContext,
  );
  installDevHooks(capture, comparison);
};

describe("development comparison hooks", () => {
  it("records an exact completion-paced reference frame count and duration", async () => {
    let context = comparisonContext("reference", "reference-run");
    const captureAfterFrames = vi.fn().mockImplementation((frames: number) => {
      context = { ...context, accumFrames: frames };
      return Promise.resolve({
        image: image(1),
        actualDurationMs: 25_600,
        frames,
      });
    });
    const comparison = createComparisonSession(
      vi.fn().mockResolvedValue(image(1)),
      vi.fn().mockResolvedValue({
        image: image(1.1),
        actualDurationMs: 5_010,
        frames: 125,
      }),
      captureAfterFrames,
      () => context,
    );

    await expect(comparison.saveReferenceAfterFrames(2_048)).resolves.toBe(
      true,
    );
    context = comparisonContext("path-traced", "target-run");
    await expect(
      comparison.compareReferenceAfter("path-traced", 5_000),
    ).resolves.toMatchObject({
      referenceFrames: 2_048,
      referenceActualDurationMs: 25_600,
      targetFrames: 125,
    });
    expect(captureAfterFrames).toHaveBeenCalledWith(2_048);
  });

  it("keeps a reference capture and scores later renders against it", async () => {
    const capture = vi
      .fn<() => Promise<LinearImage | null>>()
      .mockResolvedValueOnce(image(1))
      .mockResolvedValueOnce(image(1.25));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const captureAfter = vi.fn().mockResolvedValue({
      image: image(1.1),
      actualDurationMs: 5_012,
      frames: 240,
    });
    let context = comparisonContext("reference", "reference-run");
    installComparisonHooks(capture, captureAfter, () => context);

    await expect(globalThis.__gi?.saveReference()).resolves.toBe(true);
    context = comparisonContext("path-traced", "path-traced-run");
    const stats = await globalThis.__gi?.compareReference("path-traced");
    expect(stats?.luminanceRatio).toBeCloseTo(1.25);
    expect(stats?.meanAbsolute).toBeCloseTo(0.25);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("[web-gi] compare path-traced:"),
    );

    const report = await globalThis.__gi?.compareReferenceAfter(
      "path-traced",
      5_000,
    );
    expect(report).toMatchObject({
      actualDurationMs: 5_012,
      targetFrames: 240,
      referenceFrames: 2_048,
      mode: "path-traced",
    });
    expect(captureAfter).toHaveBeenCalledWith(5_000);
  });

  it("only saves Reference PT frames", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const context = comparisonContext("path-traced", "path-traced-run");
    installComparisonHooks(
      vi.fn().mockResolvedValue(null),
      vi.fn(),
      () => context,
    );

    await expect(globalThis.__gi?.saveReference()).rejects.toThrow(
      "Select Reference PT",
    );
    expect(info).not.toHaveBeenCalled();
  });

  it("rejects context changes during a completion-paced comparison", async () => {
    let context = comparisonContext("reference", "reference-run");
    const captureAfter = vi.fn().mockImplementation(async () => {
      context = comparisonContext("path-traced", "changed-run");
      return { image: image(1), actualDurationMs: 5_010, frames: 200 };
    });
    installComparisonHooks(
      vi.fn().mockResolvedValue(image(1)),
      captureAfter,
      () => context,
    );
    await globalThis.__gi?.saveReference();
    context = comparisonContext("path-traced", "initial-run");

    await expect(
      globalThis.__gi?.compareReferenceAfter("path-traced", 5_000),
    ).rejects.toThrow("Render settings changed");
  });
});
