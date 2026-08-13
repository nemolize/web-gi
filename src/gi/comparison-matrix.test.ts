import {
  COMPARISON_MATRIX_CASES,
  COMPARISON_MATRIX_MODES,
  COMPARISON_MATRIX_RUN_ORDERS,
  comparisonMatrixRuns,
  DEFAULT_COMPARISON_MATRIX_REPEATS,
} from "@/gi/comparison-matrix";

describe("comparison matrix", () => {
  it("pairs both renderers across the established scene and camera sweep", () => {
    expect(COMPARISON_MATRIX_MODES).toEqual(["restir", "path-traced"]);
    expect(COMPARISON_MATRIX_RUN_ORDERS).toEqual([
      ["restir", "path-traced"],
      ["path-traced", "restir"],
    ]);
    expect(COMPARISON_MATRIX_CASES.map(({ label }) => label)).toEqual([
      "classic/front",
      "classic/left",
      "classic/right-high",
      "manyLights/front",
      "manyLights/left",
      "manyLights/right-high",
    ]);
    expect(
      COMPARISON_MATRIX_CASES.slice(0, 3).map(({ camera }) => ({
        yaw: camera.yaw,
        pitch: camera.pitch,
      })),
    ).toEqual([
      { yaw: 0, pitch: 0 },
      { yaw: 0.4, pitch: 0 },
      { yaw: -0.4, pitch: 0.2 },
    ]);
  });
});

describe("comparisonMatrixRuns", () => {
  const orderIndex = (runOrder: readonly string[]): number =>
    runOrder[0] === "restir" ? 0 : 1;

  it("measures every case once per repeat", () => {
    const runs = comparisonMatrixRuns(3);
    expect(runs).toHaveLength(COMPARISON_MATRIX_CASES.length * 3);
    for (const { label } of COMPARISON_MATRIX_CASES) {
      expect(runs.filter((run) => run.label === label)).toHaveLength(3);
    }
  });

  it("runs repeats outermost so a case's repeats are spread apart", () => {
    // Back-to-back repeats would measure one thermal state three times over.
    const runs = comparisonMatrixRuns(2);
    expect(
      runs.slice(0, COMPARISON_MATRIX_CASES.length).map(({ repeat }) => repeat),
    ).toEqual(COMPARISON_MATRIX_CASES.map(() => 0));
    expect(
      runs.slice(COMPARISON_MATRIX_CASES.length).map(({ repeat }) => repeat),
    ).toEqual(COMPARISON_MATRIX_CASES.map(() => 1));
  });

  it("rotates the case order so a scene does not track elapsed time", () => {
    // A fixed order puts classic early and manyLights late in every sweep, so
    // scene and thermal state stay correlated however many repeats are run.
    const size = COMPARISON_MATRIX_CASES.length;
    const runs = comparisonMatrixRuns(size);
    for (const { label } of COMPARISON_MATRIX_CASES) {
      const positions = runs.flatMap((run, index) =>
        run.label === label ? [index % size] : [],
      );
      expect(new Set(positions).size).toBe(size);
    }
  });

  it("defaults to an even repeat count so run order balances", () => {
    expect(DEFAULT_COMPARISON_MATRIX_REPEATS % 2).toBe(0);
  });

  it("balances run order within each scene over an even repeat count", () => {
    // Parity over the flattened case list gives one scene [A,B,A] and the other
    // [B,A,B] — a 2:1 split per scene, in opposite directions, which biases the
    // per-scene comparison the matrix exists to make.
    const runs = comparisonMatrixRuns(2);
    for (const scene of ["classic", "manyLights"] as const) {
      const orders = runs
        .filter((run) => run.scene === scene)
        .map((run) => orderIndex(run.runOrder));
      expect(orders.filter((order) => order === 0)).toHaveLength(3);
      expect(orders.filter((order) => order === 1)).toHaveLength(3);
    }
  });

  it("gives both scenes the same order split when repeats are odd", () => {
    const runs = comparisonMatrixRuns(1);
    const splitFor = (scene: string): number[] =>
      runs
        .filter((run) => run.scene === scene)
        .map((run) => orderIndex(run.runOrder));
    expect(splitFor("classic")).toEqual(splitFor("manyLights"));
  });

  it("measures each case at least once for a degenerate repeat count", () => {
    expect(comparisonMatrixRuns(0)).toHaveLength(
      COMPARISON_MATRIX_CASES.length,
    );
    expect(comparisonMatrixRuns(-3)).toHaveLength(
      COMPARISON_MATRIX_CASES.length,
    );
  });

  it("pairs the two renderers in every run", () => {
    for (const run of comparisonMatrixRuns(3)) {
      expect([...run.runOrder].sort()).toEqual(
        [...COMPARISON_MATRIX_MODES].sort(),
      );
    }
  });
});
