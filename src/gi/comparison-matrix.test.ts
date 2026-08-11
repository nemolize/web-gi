import {
  COMPARISON_MATRIX_CASES,
  COMPARISON_MATRIX_MODES,
  COMPARISON_MATRIX_RUN_ORDERS,
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
