import { enumerateTechniqueMisScores } from "@/gi/bdpt/path-density";
import { techniqueMisWeights } from "@/gi/bdpt/weights";

const vertex = (forwardAreaPdf, reverseAreaPdf, delta = false) => ({
  forwardAreaPdf,
  reverseAreaPdf,
  delta,
});

describe("bidirectional path density enumeration", () => {
  it("includes camera tracing, NEE, subpath connection, and light tracing", () => {
    const densities = enumerateTechniqueMisScores(
      [
        vertex(1, 0),
        vertex(0.2, 0.3),
        vertex(0.4, 0.5),
        vertex(0.6, 0.7),
        vertex(0.8, 0.9),
      ],
      () => 1,
    );
    expect(densities.map(({ technique }) => technique)).toEqual([
      { lightVertices: 4, cameraVertices: 1 },
      { lightVertices: 3, cameraVertices: 2 },
      { lightVertices: 2, cameraVertices: 3 },
      { lightVertices: 1, cameraVertices: 4 },
      { lightVertices: 0, cameraVertices: 5 },
    ]);
    const jointPdfs = [
      0.3 * 0.5 * 0.7 * 0.9,
      0.2 * 0.5 * 0.7 * 0.9,
      0.2 * 0.4 * 0.7 * 0.9,
      0.2 * 0.4 * 0.6 * 0.9,
      0.2 * 0.4 * 0.6 * 0.8,
    ];
    const weights = techniqueMisWeights(densities);
    const denominator = jointPdfs.reduce(
      (sum, density) => sum + density ** 2,
      0,
    );
    densities.forEach(({ logRelativeDensity }, index) =>
      expect(Math.exp(logRelativeDensity)).toBeCloseTo(jointPdfs[index], 12),
    );
    weights.forEach((weight, index) =>
      expect(weight).toBeCloseTo(jointPdfs[index] ** 2 / denominator, 12),
    );
  });

  it("forbids connection at a specular vertex without deleting the entire path", () => {
    const densities = enumerateTechniqueMisScores(
      [
        vertex(1, 0),
        vertex(0.2, 0),
        vertex(0.4, 0.5, true),
        vertex(0, 0.7),
        vertex(0.8, 0.9),
      ],
      () => 1,
    );
    const weights = techniqueMisWeights(densities);
    expect(weights[0]).toBeGreaterThan(0);
    expect(weights[1]).toBe(0);
    expect(weights[2]).toBe(0);
    expect(weights[3]).toBeGreaterThan(0);
    expect(weights[4]).toBeGreaterThan(0);
    expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });
});

test("continuous zero density removes only strategies requiring that transition", () => {
  const scores = enumerateTechniqueMisScores(
    [vertex(1, 0), vertex(0, 0.5), vertex(0.25, 0.5)],
    () => 1,
  );
  expect(techniqueMisWeights(scores)).toEqual([1, 0, 0]);
  const reverseImpossible = enumerateTechniqueMisScores(
    [vertex(1, 0), vertex(0.25, 0), vertex(0.5, 0.5)],
    () => 1,
  );
  expect(techniqueMisWeights(reverseImpossible)).toEqual([0, 0.5, 0.5]);
});
