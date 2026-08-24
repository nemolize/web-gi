import { DEFAULT_CAMERA } from "@/gi/camera";
import type {
  ComparisonMatrixRunReport,
  LinearComparisonMatrixReport,
} from "@/gi/comparison-matrix";
import type { LinearComparisonReport } from "@/gi/comparison-session";
import {
  COMPARISON_METRICS,
  formatComparisonMatrixSummary,
  metricValue,
  MINIMUM_PRACTICAL_DIFFERENCE,
  summarizeComparisonMatrix,
} from "@/gi/comparison-summary";
import type { SceneVariant } from "@/gi/scene";
import type { ComparisonMode } from "@/gi/settings";
import { DEFAULT_SETTINGS } from "@/gi/settings";

const CONTEXT: LinearComparisonReport["context"] = {
  atrousVariant: "tiled-16",
  scene: "classic",
  maxBounces: 3,
  width: 640,
  height: 480,
  camera: {
    pos: { x: 0, y: 0, z: 2 },
    forward: { x: 0, y: 0, z: -1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    tanHalfFov: 0.25,
    aspect: 4 / 3,
  },
  settings: DEFAULT_SETTINGS,
};

const report = (
  mode: ComparisonMode,
  overrides: Partial<LinearComparisonReport> = {},
): LinearComparisonReport => ({
  luminanceRatio: 1,
  relativeL2: 1,
  meanAbsolute: 1,
  maxAbsolute: 1,
  outliers: 1,
  pixels: 100,
  relativeByReference: [],
  referenceDigest: "00000000",
  label: mode,
  mode,
  requestedDurationMs: 5_000,
  actualDurationMs: 5_000,
  targetFrames: 10,
  referenceFrames: 1_024,
  referenceActualDurationMs: 20_000,
  context: CONTEXT,
  ...overrides,
});

const matrixCase = (
  scene: SceneVariant,
  cameraLabel: string,
  restir: Partial<LinearComparisonReport>,
  pathTraced: Partial<LinearComparisonReport>,
  repeat = 0,
): ComparisonMatrixRunReport => ({
  label: `${scene}/${cameraLabel}`,
  scene,
  cameraLabel,
  cameraIndex: 0,
  camera: DEFAULT_CAMERA,
  repeat,
  runOrder: ["restir", "path-traced"],
  comparisons: {
    restir: report("restir", restir),
    "path-traced": report("path-traced", pathTraced),
  },
});

const matrix = (
  runs: readonly ComparisonMatrixRunReport[],
): LinearComparisonMatrixReport => ({
  kind: "comparison-matrix",
  requestedReferenceFrames: 1_024,
  requestedDurationMs: 5_000,
  repeats: new Set(runs.map(({ repeat }) => repeat)).size,
  runs,
});

describe("metricValue", () => {
  it("reads luminance as distance from unbiased, not as a raw ratio", () => {
    // A ratio of 0.9 and one of 1.1 are equally biased; a raw comparison would
    // rank the darker render as better on every case.
    expect(
      metricValue(report("restir", { luminanceRatio: 0.9 }), "luminanceError"),
    ).toBeCloseTo(0.1);
    expect(
      metricValue(report("restir", { luminanceRatio: 1.1 }), "luminanceError"),
    ).toBeCloseTo(0.1);
    expect(
      metricValue(report("restir", { luminanceRatio: 1 }), "luminanceError"),
    ).toBe(0);
  });

  it("passes the lower-is-better metrics through unchanged", () => {
    const entry = report("restir", {
      relativeL2: 0.25,
      meanAbsolute: 0.5,
      maxAbsolute: 2,
      outliers: 7,
    });
    expect(metricValue(entry, "relativeL2")).toBe(0.25);
    expect(metricValue(entry, "meanAbsolute")).toBe(0.5);
    expect(metricValue(entry, "maxAbsolute")).toBe(2);
    expect(metricValue(entry, "outliers")).toBe(7);
  });
});

describe("summarizeComparisonMatrix", () => {
  it("scores exactly the metrics it advertises", () => {
    // The tally record is built key-by-key, so a metric added to
    // COMPARISON_METRICS without a matching key would go silently unscored.
    const summary = summarizeComparisonMatrix(
      matrix([matrixCase("classic", "front", {}, {})]),
    );
    expect(Object.keys(summary.overall.tallies).sort()).toEqual(
      [...COMPARISON_METRICS].sort(),
    );
    expect(Object.keys(summary.cases[0]?.metrics ?? {}).sort()).toEqual(
      [...COMPARISON_METRICS].sort(),
    );
  });

  it("splits a verdict that the overall tally hides", () => {
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 2 }, { relativeL2: 1 }),
        matrixCase("classic", "left", { relativeL2: 2 }, { relativeL2: 1 }),
        matrixCase(
          "classic",
          "right-high",
          { relativeL2: 2 },
          { relativeL2: 1 },
        ),
        matrixCase("manyLights", "front", { relativeL2: 1 }, { relativeL2: 2 }),
        matrixCase("manyLights", "left", { relativeL2: 1 }, { relativeL2: 2 }),
        matrixCase(
          "manyLights",
          "right-high",
          { relativeL2: 1 },
          { relativeL2: 2 },
        ),
      ]),
    );

    expect(summary.overall.tallies.relativeL2.wins).toEqual({
      restir: 3,
      "path-traced": 3,
    });

    expect(
      summary.byScene.map(({ scope, tallies }) => ({
        scope,
        wins: tallies.relativeL2.wins,
      })),
    ).toEqual([
      { scope: "classic", wins: { restir: 0, "path-traced": 3 } },
      { scope: "manyLights", wins: { restir: 3, "path-traced": 0 } },
    ]);
  });

  it("scores every metric independently on one case", () => {
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase(
          "classic",
          "front",
          { relativeL2: 1, meanAbsolute: 5, luminanceRatio: 1.2 },
          { relativeL2: 2, meanAbsolute: 1, luminanceRatio: 0.95 },
        ),
      ]),
    );

    const metrics = summary.cases[0]?.metrics;
    expect(metrics?.relativeL2.winner).toBe("restir");
    expect(metrics?.meanAbsolute.winner).toBe("path-traced");
    // |1.2 - 1| = 0.2 against |0.95 - 1| = 0.05.
    expect(metrics?.luminanceError.winner).toBe("path-traced");
  });

  it("records an exact tie as neither renderer's win", () => {
    const summary = summarizeComparisonMatrix(
      matrix([matrixCase("classic", "front", {}, {})]),
    );
    const tally = summary.overall.tallies.relativeL2;
    expect(tally.wins).toEqual({ restir: 0, "path-traced": 0 });
    expect(tally.ties).toBe(1);
    expect(summary.cases[0]?.metrics.relativeL2.winner).toBeNull();
  });

  it("refuses to pick a winner when either value is not finite", () => {
    // NaN loses every comparison, so a `<` test would silently hand the win to
    // whichever side happens to be finite.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase(
          "classic",
          "front",
          { relativeL2: Number.NaN },
          { relativeL2: 1 },
        ),
        matrixCase(
          "classic",
          "left",
          { relativeL2: 1 },
          { relativeL2: Number.NaN },
        ),
      ]),
    );

    expect(
      summary.cases.map((entry) => entry.metrics.relativeL2.winner),
    ).toEqual([null, null]);
    expect(summary.overall.tallies.relativeL2).toEqual({
      wins: { restir: 0, "path-traced": 0 },
      ties: 2,
      unanimous: 0,
    });
  });

  it("folds a case's repeats into one verdict on the median", () => {
    // The middle repeat is what decides it; a single slow outlier in the last
    // repeat must not flip the case the way a mean would.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 2 }, 0),
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 2 }, 1),
        matrixCase(
          "classic",
          "front",
          { relativeL2: 1 },
          { relativeL2: 90 },
          2,
        ),
      ]),
    );

    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0]?.repeats).toBe(3);
    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.winner).toBe("restir");
    expect(verdict?.samples["path-traced"]).toEqual({
      median: 2,
      min: 2,
      max: 90,
      count: 3,
    });
  });

  it("averages the two middle repeats when the repeat count is even", () => {
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 1 }, 0),
        matrixCase("classic", "front", { relativeL2: 4 }, { relativeL2: 1 }, 1),
      ]),
    );
    expect(summary.cases[0]?.metrics.relativeL2.samples.restir.median).toBe(
      2.5,
    );
  });

  it("decides on paired repeats, not on each renderer's median", () => {
    // The medians come from different repeats, so they can disagree with what
    // happened inside every repeat: median says path-traced, yet ReSTIR is
    // lower in two of the three head-to-heads.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 2 }, 0),
        matrixCase(
          "classic",
          "front",
          { relativeL2: 100 },
          { relativeL2: 3 },
          1,
        ),
        matrixCase(
          "classic",
          "front",
          { relativeL2: 101 },
          { relativeL2: 200 },
          2,
        ),
      ]),
    );

    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.samples.restir.median).toBe(100);
    expect(verdict?.samples["path-traced"].median).toBe(3);
    expect(verdict?.lowerErrorRepeats).toEqual({ restir: 2, "path-traced": 1 });
    expect(verdict?.winner).toBe("restir");
  });

  it("cancels a repeat's conditions inside the pair", () => {
    // Both renderers are twice as slow in the second repeat. The paired
    // difference is unchanged by that; the raw values are not.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 2 }, 0),
        matrixCase("classic", "front", { relativeL2: 2 }, { relativeL2: 4 }, 1),
      ]),
    );

    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.differences).toEqual([2 / 3, 2 / 3]);
    expect(verdict?.winner).toBe("restir");
  });

  it("calls a win under the practical difference a tie", () => {
    // Half a percent apart is the same image, not one renderer being better.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase(
          "classic",
          "front",
          { relativeL2: 1 },
          { relativeL2: 1.005 },
          0,
        ),
        matrixCase(
          "classic",
          "front",
          { relativeL2: 1 },
          { relativeL2: 1.005 },
          1,
        ),
      ]),
    );

    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.lowerErrorRepeats.restir).toBe(2);
    expect(verdict?.winner).toBeNull();
    expect(summary.overall.tallies.relativeL2.ties).toBe(1);
  });

  it("never calls a single-repeat win unanimous", () => {
    // One repeat cannot agree with itself about anything.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 90 }),
      ]),
    );
    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.winner).toBe("restir");
    expect(verdict?.unanimous).toBe(false);
  });

  it("marks a split verdict as not unanimous", () => {
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 3 }, 0),
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 3 }, 1),
        matrixCase("classic", "front", { relativeL2: 9 }, { relativeL2: 3 }, 2),
      ]),
    );

    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.winner).toBe("restir");
    expect(verdict?.lowerErrorRepeats).toEqual({ restir: 2, "path-traced": 1 });
    expect(verdict?.unanimous).toBe(false);
    expect(summary.overall.tallies.relativeL2.unanimous).toBe(0);
  });

  it("marks a win every repeat agrees on as unanimous", () => {
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 1 }, { relativeL2: 5 }, 0),
        matrixCase("classic", "front", { relativeL2: 2 }, { relativeL2: 6 }, 1),
      ]),
    );

    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.winner).toBe("restir");
    expect(verdict?.unanimous).toBe(true);
    expect(summary.overall.tallies.relativeL2.unanimous).toBe(1);
  });

  it("reads a path-traced win the same way", () => {
    // The sign of the difference decides, so both directions need pinning.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 5 }, { relativeL2: 1 }, 0),
        matrixCase("classic", "front", { relativeL2: 6 }, { relativeL2: 2 }, 1),
      ]),
    );

    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.medianDifference).toBeLessThan(0);
    expect(verdict?.winner).toBe("path-traced");
    expect(verdict?.unanimous).toBe(true);
  });

  it("calls two identical renderers a tie rather than a win", () => {
    // Every difference is exactly zero, including where both errors are.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { relativeL2: 0 }, { relativeL2: 0 }, 0),
        matrixCase("classic", "front", { relativeL2: 4 }, { relativeL2: 4 }, 1),
      ]),
    );

    const verdict = summary.cases[0]?.metrics.relativeL2;
    expect(verdict?.differences).toEqual([0, 0]);
    expect(verdict?.winner).toBeNull();
    expect(verdict?.unanimous).toBe(false);
  });

  it("calls a unanimous run at the rate the doc comment claims", () => {
    // Unanimity is a sign test, so on renderers that do not differ it fires at
    // 2/2^n. Enumerate every direction pattern of three repeats to pin the
    // p=0.25 the doc comment and README quote.
    const patterns: boolean[][] = [];
    const walk = (taken: boolean[]): void => {
      if (taken.length === 3) {
        patterns.push(taken);
        return;
      }
      walk([...taken, true]);
      walk([...taken, false]);
    };
    walk([]);
    expect(patterns).toHaveLength(8);

    const unanimous = patterns.filter((restirWins) => {
      const runs = restirWins.map((restirLower, repeat) =>
        matrixCase(
          "classic",
          "front",
          { relativeL2: restirLower ? 1 : 2 },
          { relativeL2: restirLower ? 2 : 1 },
          repeat,
        ),
      );
      return (
        summarizeComparisonMatrix(matrix(runs)).cases[0]?.metrics.relativeL2
          .unanimous === true
      );
    }).length;

    expect(unanimous / patterns.length).toBeCloseTo(0.25, 10);
  });

  it("refuses a verdict when any single repeat is not finite", () => {
    // The NaN must sit off the median: sort leaves it in place, so a middle NaN
    // becomes the median and nulls the verdict even with the guard removed.
    for (const position of [0, 1, 2]) {
      const summary = summarizeComparisonMatrix(
        matrix(
          [0, 1, 2].map((repeat) =>
            matrixCase(
              "classic",
              "front",
              { relativeL2: repeat === position ? Number.NaN : 1 },
              { relativeL2: 2 },
              repeat,
            ),
          ),
        ),
      );
      expect(summary.cases[0]?.metrics.relativeL2.winner).toBeNull();
    }
  });

  it("puts the tie boundary at the tolerance", () => {
    // Straddles it from both sides; the exact value is not representable, so
    // the pin is that a hair above decides and a hair below does not.
    const pathTracedFor = (difference: number): number =>
      (2 + difference) / (2 - difference);
    const winnerAt = (difference: number): ComparisonMode | null | undefined =>
      summarizeComparisonMatrix(
        matrix([
          matrixCase(
            "classic",
            "front",
            { relativeL2: 1 },
            { relativeL2: pathTracedFor(difference) },
          ),
        ]),
      ).cases[0]?.metrics.relativeL2.winner;

    expect(winnerAt(MINIMUM_PRACTICAL_DIFFERENCE * 1.001)).toBe("restir");
    expect(winnerAt(MINIMUM_PRACTICAL_DIFFERENCE * 0.999)).toBeNull();
  });

  it("leaves the diagnostic metrics without the tie tolerance", () => {
    // outliers is a count: 100 against 101 is under 1% but still a real gap.
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("classic", "front", { outliers: 100 }, { outliers: 101 }),
      ]),
    );
    expect(summary.cases[0]?.metrics.outliers.winner).toBe("restir");
  });

  it("keeps scenes in the order they were measured", () => {
    const summary = summarizeComparisonMatrix(
      matrix([
        matrixCase("manyLights", "front", {}, {}),
        matrixCase("classic", "front", {}, {}),
      ]),
    );
    expect(summary.byScene.map(({ scope }) => scope)).toEqual([
      "manyLights",
      "classic",
    ]);
  });

  it("summarises an empty matrix without inventing a winner", () => {
    const summary = summarizeComparisonMatrix(matrix([]));
    expect(summary.cases).toEqual([]);
    expect(summary.byScene).toEqual([]);
    expect(summary.overall.cases).toBe(0);
    expect(
      Object.values(summary.overall.tallies).every(
        (tally) => tally.wins.restir === 0 && tally.wins["path-traced"] === 0,
      ),
    ).toBe(true);
  });
});

describe("formatComparisonMatrixSummary", () => {
  it("renders per-scene tallies a reader can paste into an issue", () => {
    const text = formatComparisonMatrixSummary(
      summarizeComparisonMatrix(
        matrix([
          matrixCase("classic", "front", { relativeL2: 2 }, { relativeL2: 1 }),
          matrixCase(
            "manyLights",
            "front",
            { relativeL2: 1 },
            { relativeL2: 2 },
          ),
        ]),
      ),
    );

    expect(text).toContain("### classic (1 cases)");
    expect(text).toContain("### manyLights (1 cases)");
    expect(text).toContain(
      "relative L2 **(primary)**: ReSTIR 0/1 · Denoised PT 1/1",
    );
    expect(text).toContain(
      "relative L2 **(primary)**: ReSTIR 1/1 · Denoised PT 0/1",
    );
    expect(text).toContain("| classic/front | relative L2 |");
    // Counts, not radiance, so an integer metric must not gain six decimals.
    expect(text).toContain("| outliers | 1 | 1 | +0.00% | 0:0 | tie |");
    // A tie is its own outcome; without it the two win counts read as the whole
    // story and the remainder looks like the other renderer's.
    expect(text).toContain(
      "outliers (diagnostic): ReSTIR 0/2 · Denoised PT 0/2 · ties 2",
    );
  });
});
