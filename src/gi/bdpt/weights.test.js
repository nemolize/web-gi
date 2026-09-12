import {
  initialResamplingWeight,
  techniqueMisWeights,
} from "@/gi/bdpt/weights";

const technique = (lightVertices, cameraVertices) => ({
  lightVertices,
  cameraVertices,
});

describe("bidirectional technique weights", () => {
  it("forms a partition of unity using sample-count-weighted power MIS", () => {
    const weights = techniqueMisWeights([
      {
        technique: technique(0, 4),
        logRelativeDensity: Math.log(0.25),
        sampleCount: 1,
      },
      {
        technique: technique(1, 3),
        logRelativeDensity: Math.log(0.5),
        sampleCount: 2,
      },
      {
        technique: technique(2, 2),
        logRelativeDensity: -Infinity,
        sampleCount: 1,
      },
    ]);
    expect(weights[0]).toBeCloseTo(1 / 17, 12);
    expect(weights[1]).toBeCloseTo(16 / 17, 12);
    expect(weights[2]).toBe(0);
    expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  it("preserves MIS weights when all path densities share a tiny factor", () => {
    const densities = [
      {
        technique: technique(0, 4),
        logRelativeDensity: Math.log(0.2),
        sampleCount: 1,
      },
      {
        technique: technique(1, 3),
        logRelativeDensity: Math.log(0.6),
        sampleCount: 1,
      },
      {
        technique: technique(3, 1),
        logRelativeDensity: Math.log(0.4),
        sampleCount: 16,
      },
    ];
    const expected = techniqueMisWeights(densities);
    const actual = techniqueMisWeights(
      densities.map((entry) => ({
        ...entry,
        logRelativeDensity: entry.logRelativeDensity - 1000,
      })),
    );
    actual.forEach((weight, index) =>
      expect(weight).toBeCloseTo(expected[index], 12),
    );
  });

  it("assigns no weight to disabled and unsampleable strategies", () => {
    expect(
      techniqueMisWeights([
        {
          technique: technique(1, 2),
          logRelativeDensity: Math.log(1),
          sampleCount: 0,
        },
        {
          technique: technique(2, 1),
          logRelativeDensity: -Infinity,
          sampleCount: 16,
        },
      ]),
    ).toEqual([0, 0]);
  });

  it("normalizes light splats by globally launched paths, not pixel arrivals", () => {
    const lightTracing = technique(3, 1);
    const cameraTracing = technique(1, 3);
    const emittedPathCount = 100;
    const arrivals = Array.from({ length: 7 }, () => 3);
    const estimate = arrivals.reduce(
      (sum, contribution) =>
        sum +
        contribution * initialResamplingWeight(lightTracing, emittedPathCount),
      0,
    );
    expect(estimate).toBeCloseTo(0.21, 12);
    expect(initialResamplingWeight(cameraTracing, emittedPathCount)).toBe(1);
    expect(initialResamplingWeight(lightTracing, emittedPathCount * 2)).toBe(
      0.005,
    );
  });
});
