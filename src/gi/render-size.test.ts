import { MAX_RENDER_PIXELS, resolveRenderSize } from "@/gi/render-size";

const MAX_RENDER_DIMENSION = 8192;

describe("resolveRenderSize", () => {
  it("uses CSS pixels on a standard-density display", () => {
    expect(resolveRenderSize(800, 600, 1, 1, MAX_RENDER_DIMENSION)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("uses device pixels on a high-density display", () => {
    expect(resolveRenderSize(200, 100, 1, 2, MAX_RENDER_DIMENSION)).toEqual({
      width: 400,
      height: 200,
    });
  });

  it("applies the resolution scale relative to device pixels", () => {
    expect(resolveRenderSize(200, 100, 0.75, 2, MAX_RENDER_DIMENSION)).toEqual({
      width: 300,
      height: 150,
    });
  });

  it("preserves the aspect ratio within the pixel budget", () => {
    const size = resolveRenderSize(1600, 900, 1, 2, MAX_RENDER_DIMENSION);

    expect(size).toEqual({ width: 1333, height: 750 });
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
  });

  it("keeps narrow targets useful when an exact ratio wastes the budget", () => {
    expect(resolveRenderSize(2, 1_000_000, 1, 1, 1_000_000)).toEqual({
      width: 1,
      height: 707_106,
    });
  });

  it("limits each axis to the device capability", () => {
    expect(resolveRenderSize(20_000, 10, 1, 1, MAX_RENDER_DIMENSION)).toEqual({
      width: MAX_RENDER_DIMENSION,
      height: 4,
    });
  });

  it("changes smoothly across a one-pixel resize", () => {
    const before = resolveRenderSize(1366, 768, 1, 1, MAX_RENDER_DIMENSION);
    const after = resolveRenderSize(1367, 768, 1, 1, MAX_RENDER_DIMENSION);

    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    expect(before.width * before.height).toBeGreaterThan(
      MAX_RENDER_PIXELS * 0.99,
    );
    expect(after.width * after.height).toBeGreaterThan(
      MAX_RENDER_PIXELS * 0.99,
    );
  });

  it.each([
    [2_000_000, 1, { width: MAX_RENDER_DIMENSION, height: 1 }],
    [1, 2_000_000, { width: 1, height: MAX_RENDER_DIMENSION }],
  ] as const)(
    "keeps an extreme %d × %d aspect ratio within every limit",
    (cssWidth, cssHeight, expected) => {
      const size = resolveRenderSize(
        cssWidth,
        cssHeight,
        1,
        1,
        MAX_RENDER_DIMENSION,
      );

      expect(size).toEqual(expected);
      expect(size.width * size.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
      expect(size.width).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
      expect(size.height).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
    },
  );

  it.each([
    [Number.POSITIVE_INFINITY, 600, 1, 1, MAX_RENDER_DIMENSION],
    [800, 600, Number.POSITIVE_INFINITY, 1, MAX_RENDER_DIMENSION],
    [800, 600, Number.MAX_VALUE, Number.MAX_VALUE, MAX_RENDER_DIMENSION],
  ])("falls back safely for invalid or overflowing inputs", (...input) => {
    expect(resolveRenderSize(...input)).toEqual({ width: 1, height: 1 });
  });
});
