import { describe, expect, it } from "vitest";

// Grazing angles amplify pixel-rounding bias in world-distance rejection.
// These WGSL mirrors must stay synchronized with common.wgsl.
const SPATIAL_MIN_PIXEL_RADIUS = 1;

const spatialOffset = (
  pixelRadius: number,
  angle: number,
  u: number,
): readonly [number, number] => {
  const radius = Math.max(pixelRadius * Math.sqrt(u), SPATIAL_MIN_PIXEL_RADIUS);
  return [
    Math.round(Math.cos(angle) * radius),
    Math.round(Math.sin(angle) * radius),
  ];
};

const outwardOffset = (
  pixelRadius: number,
  angle: number,
  u: number,
): readonly [number, number] => {
  const radius = Math.max(pixelRadius * Math.sqrt(u), SPATIAL_MIN_PIXEL_RADIUS);
  const dx = Math.cos(angle) * radius;
  const dy = Math.sin(angle) * radius;
  return [
    Math.sign(dx) * Math.ceil(Math.abs(dx)),
    Math.sign(dy) * Math.ceil(Math.abs(dy)),
  ];
};

const lcg = (state: number) => () => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 4294967296;
};

/**
 * Fraction of taps landing inside the guard, where the surface is tilted so one
 * screen axis maps to `1 / incidenceCosine` times as much world distance.
 */
const acceptanceRate = (
  offset: typeof spatialOffset,
  pixelRadius: number,
  incidenceCosine: number,
): number => {
  const random = lcg(0x5eed);
  const trials = 40_000;
  let accepted = 0;
  for (let i = 0; i < trials; i += 1) {
    const [dx, dy] = offset(pixelRadius, random() * 2 * Math.PI, random());
    const alongSurface = dy / incidenceCosine;
    if (Math.hypot(dx, alongSurface) <= pixelRadius) accepted += 1;
  }
  return accepted / trials;
};

const GRAZING_COSINE = 0.1;
const PIXEL_RADII = [7, 14, 21, 28];

describe("spatialOffset", () => {
  it("never lands on the centre pixel, which would merge a reservoir into itself", () => {
    const random = lcg(0xc0ffee);
    for (let i = 0; i < 200_000; i += 1) {
      const pixelRadius = 1 + random() * 63;
      const [dx, dy] = spatialOffset(
        pixelRadius,
        random() * 2 * Math.PI,
        random(),
      );
      expect(Math.abs(dx) + Math.abs(dy)).toBeGreaterThan(0);
    }
  });

  it("keeps grazing-angle acceptance flat across resolutions", () => {
    const rates = PIXEL_RADII.map((pixelRadius) =>
      acceptanceRate(spatialOffset, pixelRadius, GRAZING_COSINE),
    );
    expect(Math.max(...rates) / Math.min(...rates)).toBeLessThan(1.5);
  });

  it("is what the previous outward rounding failed to do", () => {
    const rates = PIXEL_RADII.map((pixelRadius) =>
      acceptanceRate(outwardOffset, pixelRadius, GRAZING_COSINE),
    );
    const smallest = Math.min(...rates);
    expect(smallest).toBeLessThan(0.01);
    expect(Math.max(...rates) / Math.max(smallest, 1e-6)).toBeGreaterThan(5);
  });
});
