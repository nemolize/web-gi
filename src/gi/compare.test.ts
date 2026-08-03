import type { LinearImage } from "@/gi/compare";
import { compareLinear } from "@/gi/compare";

const image = (pixels: readonly (readonly [number, number, number])[]) => ({
  width: pixels.length,
  height: 1,
  data: new Float32Array(pixels.flatMap(([r, g, b]) => [r, g, b, 1])),
});

const flat = (value: number, count = 4): LinearImage =>
  image(Array.from({ length: count }, () => [value, value, value] as const));

describe("compareLinear", () => {
  it("reports no error against itself", () => {
    const stats = compareLinear(flat(0.5), flat(0.5));
    expect(stats.luminanceRatio).toBeCloseTo(1);
    expect(stats.relativeL2).toBeCloseTo(0);
    expect(stats.meanAbsolute).toBeCloseTo(0);
    expect(stats.maxAbsolute).toBeCloseTo(0);
    expect(stats.outliers).toBe(0);
  });

  // The renderer's documented bias is a luminance ratio, so that term has to
  // read the shortfall directly rather than through a squared error.
  it("reads a uniform 10% shortfall as a 0.9 luminance ratio", () => {
    const stats = compareLinear(flat(0.9), flat(1));
    expect(stats.luminanceRatio).toBeCloseTo(0.9);
    expect(stats.meanAbsolute).toBeCloseTo(0.1);
  });

  // Scale independence is the whole reason for the relative term: the same
  // proportional error in a dim corner and a bright wall must score alike,
  // which a plain RMSE — dominated by the bright one — would not do.
  it("scores equal proportional error equally at different brightness", () => {
    const dim = compareLinear(flat(0.09), flat(0.1));
    const bright = compareLinear(flat(9), flat(10));
    expect(dim.relativeL2).toBeCloseTo(bright.relativeL2, 2);
    expect(dim.meanAbsolute).toBeLessThan(bright.meanAbsolute);
  });

  // A localised leak is what the per-candidate visibility test guards against;
  // averaged over a frame it vanishes, so the tail terms must expose it.
  it("exposes a single leaking pixel that the mean hides", () => {
    const reference = flat(1, 100);
    const leaked = flat(1, 100);
    leaked.data[0] = 5;
    const stats = compareLinear(leaked, reference);
    expect(stats.meanAbsolute).toBeLessThan(0.02);
    expect(stats.maxAbsolute).toBeCloseTo(4);
    expect(stats.outliers).toBe(1);
  });

  it("counts outliers by the worst channel, not by luminance", () => {
    const reference = flat(1, 2);
    const tinted = flat(1, 2);
    tinted.data[2] = 1.5;
    const stats = compareLinear(tinted, reference);
    expect(stats.outliers).toBe(1);
    // Blue carries 7% of luminance, so +0.5 on one of two pixels moves the
    // ratio by under 2% while the channel itself is 50% out.
    expect(stats.luminanceRatio).toBeCloseTo(1.018, 3);
    expect(stats.maxAbsolute).toBeCloseTo(0.5);
  });

  it("does not divide by zero on a black reference", () => {
    const stats = compareLinear(flat(0.1), flat(0));
    expect(Number.isFinite(stats.relativeL2)).toBe(true);
    expect(stats.luminanceRatio).toBe(0);
  });

  it("rejects a size mismatch rather than comparing the overlap", () => {
    expect(() => compareLinear(flat(1, 4), flat(1, 5))).toThrow("dimensions");
  });

  it("rejects an empty image", () => {
    expect(() =>
      compareLinear(
        { width: 0, height: 0, data: new Float32Array() },
        { width: 0, height: 0, data: new Float32Array() },
      ),
    ).toThrow("empty");
  });
});
