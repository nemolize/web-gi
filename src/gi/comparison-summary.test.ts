import { DEFAULT_CAMERA } from "@/gi/camera";
import type {
  ComparisonMatrixCaseReport,
  LinearComparisonMatrixReport,
} from "@/gi/comparison-matrix";
import type { LinearComparisonReport } from "@/gi/comparison-session";
import {
  COMPARISON_METRICS,
  formatComparisonMatrixSummary,
  metricValue,
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
): ComparisonMatrixCaseReport => ({
  label: `${scene}/${cameraLabel}`,
  scene,
  cameraLabel,
  camera: DEFAULT_CAMERA,
  runOrder: ["restir", "path-traced"],
  comparisons: {
    restir: report("restir", restir),
    "path-traced": report("path-traced", pathTraced),
  },
});

const matrix = (
  cases: readonly ComparisonMatrixCaseReport[],
): LinearComparisonMatrixReport => ({
  kind: "comparison-matrix",
  requestedReferenceFrames: 1_024,
  requestedDurationMs: 5_000,
  cases,
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
    });
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
    expect(text).toContain("relative L2: ReSTIR 0/1 · Denoised PT 1/1");
    expect(text).toContain("relative L2: ReSTIR 1/1 · Denoised PT 0/1");
    expect(text).toContain("| classic/front | relative L2 |");
    // Counts, not radiance, so an integer metric must not gain six decimals.
    expect(text).toContain("| outliers | 1 | 1 | tie |");
    // A tie is its own outcome; without it the two win counts read as the whole
    // story and the remainder looks like the other renderer's.
    expect(text).toContain("outliers: ReSTIR 0/2 · Denoised PT 0/2 · ties 2");
  });
});
