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

  // The bands are the whole point of the split: a reader has to be able to
  // add them up and land on the figure the run reported.
  it("splits the relative term into bands that sum to the reported total", () => {
    const stats = compareLinear(
      image([
        [0.0005, 0.02, 0.5],
        [2, 0.05, 0.005],
      ]),
      image([
        [0, 0.03, 0.4],
        [3, 0.05, 0.008],
      ]),
    );
    const summed = stats.relativeByReference.reduce(
      (total, bin) => total + bin.relativeL2,
      0,
    );
    expect(summed).toBeCloseTo(stats.relativeL2, 12);
    expect(
      stats.relativeByReference.reduce((total, bin) => total + bin.channels, 0),
    ).toBe(stats.pixels * 3);
  });

  // The diagnostic exists to answer one question: did an outlying figure come
  // from the bins where the epsilon, not the reference, is the denominator?
  it("attributes a near-black error to the darkest band", () => {
    const reference = flat(0, 4);
    const render = flat(0, 4);
    render.data[0] = 0.1;
    const stats = compareLinear(render, reference);
    const darkest = stats.relativeByReference[0];
    expect(darkest?.to).toBe(0.001);
    expect(darkest?.relativeL2).toBeCloseTo(stats.relativeL2, 12);
  });

  // A lit pixel with the same absolute error must not land in the dark bands,
  // or the diagnostic would blame the denominator for ordinary render error.
  it("attributes a lit error to a bright band, not the dark ones", () => {
    const reference = flat(1, 4);
    const render = flat(1, 4);
    render.data[0] = 1.1;
    const stats = compareLinear(render, reference);
    expect(stats.relativeByReference[0]?.relativeL2).toBe(0);
    const brightest = stats.relativeByReference.at(-1);
    expect(brightest?.from).toBe(1);
    expect(brightest?.relativeL2).toBeCloseTo(stats.relativeL2, 12);
  });

  // Repeats of one case build their own oracle, so the digest is what tells
  // two runs apart when only the reference-magnitude metric moves.
  it("digests equal references alike and unequal ones differently", () => {
    const render = flat(0.5);
    expect(compareLinear(render, flat(0.25)).referenceDigest).toBe(
      compareLinear(render, flat(0.25)).referenceDigest,
    );
    const nudged = flat(0.25);
    nudged.data[5] = 0.2500001;
    expect(compareLinear(render, nudged).referenceDigest).not.toBe(
      compareLinear(render, flat(0.25)).referenceDigest,
    );
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
