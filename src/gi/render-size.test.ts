import type { RenderSizeRequest } from "@/gi/render-size";
import { MAX_RENDER_PIXELS, resolveRenderSize } from "@/gi/render-size";

const MAX_RENDER_DIMENSION = 8192;

type Overrides = Partial<RenderSizeRequest> &
  Pick<RenderSizeRequest, "cssWidth" | "cssHeight">;

/** Fills in the fields a case is not exercising, so only those it is show up. */
const resolve = (request: Overrides) =>
  resolveRenderSize({
    resolutionScale: 1,
    devicePixelRatio: 1,
    maxDimension: MAX_RENDER_DIMENSION,
    ...request,
  });

describe("resolveRenderSize", () => {
  it("uses CSS pixels on a standard-density display", () => {
    expect(resolve({ cssWidth: 800, cssHeight: 600 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("uses device pixels on a high-density display", () => {
    expect(
      resolve({ cssWidth: 200, cssHeight: 100, devicePixelRatio: 2 }),
    ).toEqual({ width: 400, height: 200 });
  });

  it("applies the resolution scale relative to device pixels", () => {
    expect(
      resolve({
        cssWidth: 200,
        cssHeight: 100,
        resolutionScale: 0.75,
        devicePixelRatio: 2,
      }),
    ).toEqual({ width: 300, height: 150 });
  });

  it("preserves the aspect ratio within the pixel budget", () => {
    const size = resolve({
      cssWidth: 1600,
      cssHeight: 900,
      devicePixelRatio: 2,
    });

    expect(size).toEqual({ width: 1333, height: 750 });
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
  });

  it("keeps narrow targets useful when an exact ratio wastes the budget", () => {
    expect(
      resolve({
        cssWidth: 2,
        cssHeight: 1_000_000,
        maxDimension: 1_000_000,
      }),
    ).toEqual({ width: 1, height: 707_106 });
  });

  it("limits each axis to the device capability", () => {
    expect(resolve({ cssWidth: 20_000, cssHeight: 10 })).toEqual({
      width: MAX_RENDER_DIMENSION,
      height: 4,
    });
  });

  it("changes smoothly across a one-pixel resize", () => {
    const before = resolve({ cssWidth: 1366, cssHeight: 768 });
    const after = resolve({ cssWidth: 1367, cssHeight: 768 });

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
      const size = resolve({ cssWidth, cssHeight });

      expect(size).toEqual(expected);
      expect(size.width * size.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
      expect(size.width).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
      expect(size.height).toBeLessThanOrEqual(MAX_RENDER_DIMENSION);
    },
  );

  // The renderer lowers the budget when a device cannot allocate the targets.
  it("honours a caller-supplied pixel budget", () => {
    const size = resolve({ cssWidth: 800, cssHeight: 600, maxPixels: 65_536 });

    expect(size.width * size.height).toBeLessThanOrEqual(65_536);
    expect(size.width / size.height).toBeCloseTo(800 / 600, 2);
  });

  it.each<Overrides>([
    { cssWidth: Number.POSITIVE_INFINITY, cssHeight: 600 },
    {
      cssWidth: 800,
      cssHeight: 600,
      resolutionScale: Number.POSITIVE_INFINITY,
    },
    {
      cssWidth: 800,
      cssHeight: 600,
      resolutionScale: Number.MAX_VALUE,
      devicePixelRatio: Number.MAX_VALUE,
    },
    { cssWidth: 800, cssHeight: 600, maxPixels: 0 },
    { cssWidth: 800, cssHeight: 600, maxPixels: Number.NaN },
    // The only budget the finiteness check catches on its own: every other
    // invalid value also collapses the shrink factor further down.
    { cssWidth: 800, cssHeight: 600, maxPixels: Number.POSITIVE_INFINITY },
  ])("falls back safely for invalid or overflowing inputs", (request) => {
    expect(resolve(request)).toEqual({ width: 1, height: 1 });
  });
});
