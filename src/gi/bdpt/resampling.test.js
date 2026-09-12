import {
  generalizedBalanceWeights,
  pathTarget,
  resamplePaths,
  reservoirRadiance,
} from "@/gi/bdpt/resampling";
import { initialResamplingWeight } from "@/gi/bdpt/weights";
import { add, scale, vec3 } from "@/gi/math";

const sample = (
  lightVertices,
  cameraVertices,
  contribution,
  techniqueWeight,
) => ({
  technique: { lightVertices, cameraVertices },
  cameraSeed: 123,
  lightSeed: 456,
  contribution,
  techniqueWeight,
});

const expectVector = (actual, expected) => {
  for (const channel of ["x", "y", "z"])
    expect(actual[channel]).toBeCloseTo(expected[channel], 12);
};

describe("technique-aware path resampling", () => {
  it("preserves the expected contribution across camera and light strategies", () => {
    const a = sample(2, 3, vec3(2, 4, 1), 0.3);
    const b = sample(4, 1, vec3(5, 1, 3), 0.7);
    const candidates = [
      {
        sample: a,
        contributionWeight: 4,
        resamplingWeight: initialResamplingWeight(a.technique, 16),
        jacobian: 1,
      },
      {
        sample: b,
        contributionWeight: 8,
        resamplingWeight: initialResamplingWeight(b.technique, 16),
        jacobian: 1,
      },
    ];
    const weights = candidates.map(
      (candidate) =>
        pathTarget(candidate.sample) *
        candidate.contributionWeight *
        candidate.resamplingWeight,
    );
    const probabilityA = weights[0] / (weights[0] + weights[1]);
    const chooseA = resamplePaths(candidates, 1, () => 1 - Number.EPSILON);
    const chooseB = resamplePaths(candidates, 1, () => 0);
    expect(chooseA.sample).toBe(a);
    expect(chooseB.sample).toBe(b);
    const expectation = add(
      scale(reservoirRadiance(chooseA), probabilityA),
      scale(reservoirRadiance(chooseB), 1 - probabilityA),
    );
    expectVector(
      expectation,
      add(
        scale(a.contribution, 0.3 * 4),
        scale(b.contribution, (0.7 * 8) / 16),
      ),
    );
  });

  it("retains confidence for empty frames independently of arriving samples", () => {
    const empty = resamplePaths([], 7, () => 0);
    const dark = resamplePaths(
      [
        {
          sample: sample(3, 1, vec3(0, 0, 0), 1),
          contributionWeight: 1,
          resamplingWeight: 1,
          jacobian: 1,
        },
      ],
      7,
      () => 0,
    );
    expect(empty).toEqual(dark);
    expect(empty.confidence).toBe(7);
    expectVector(reservoirRadiance(empty), vec3(0, 0, 0));
  });

  it("transforms target densities with the inverse shift Jacobian", () => {
    expect(
      generalizedBalanceWeights([
        { confidence: 1, sourceTarget: 2, inverseJacobian: 1 },
        { confidence: 4, sourceTarget: 3, inverseJacobian: 0.5 },
        { confidence: 100, sourceTarget: 5, inverseJacobian: 0 },
      ]),
    ).toEqual([0.25, 0.75, 0]);
  });

  it("applies the forward Jacobian when integrating a shifted candidate", () => {
    const shifted = sample(2, 2, vec3(3, 6, 9), 0.5);
    const result = resamplePaths(
      [
        {
          sample: shifted,
          contributionWeight: 4,
          resamplingWeight: 0.25,
          jacobian: 2,
        },
      ],
      5,
      () => 0,
    );
    expectVector(reservoirRadiance(result), vec3(3, 6, 9));
    expect(result.sample.technique).toEqual({
      lightVertices: 2,
      cameraVertices: 2,
    });
  });
});

test("the target includes the technique MIS weight before reservoir selection", () => {
  const path = sample(2, 3, vec3(1, 2, 3), 0.25);
  expect(pathTarget(path)).toBeCloseTo(
    (0.2126 + 2 * 0.7152 + 3 * 0.0722) * 0.25,
    12,
  );
  expect(pathTarget({ ...path, techniqueWeight: 0 })).toBe(0);
});
