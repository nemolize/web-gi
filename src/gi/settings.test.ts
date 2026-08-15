import {
  autoComparisonMode,
  DEFAULT_SETTINGS,
  FLAG_DENOISE,
  FLAG_DI_ENABLED,
  FLAG_DI_SPATIAL,
  FLAG_DI_TEMPORAL,
  FLAG_GI_ENABLED,
  FLAG_GI_SPATIAL,
  FLAG_GI_TEMPORAL,
  MATRIX_RESOLUTION_SCALES,
  packFlags,
  requiresAccumulationReset,
  sanitizedRenderQueryParams,
  settingsFromSearch,
  shouldAutoMeasure,
} from "@/gi/settings";

describe("render query", () => {
  it("loads the heavy benchmark preset with a selected renderer", () => {
    expect(
      settingsFromSearch("?preset=heavy&mode=path-traced&measure=auto"),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      scene: "manyLights",
      mode: "path-traced",
      diCandidates: 32,
      spatialSamples: 8,
      maxBounces: 6,
      resolutionScale: 0.75,
    });
    expect(
      shouldAutoMeasure("?preset=heavy&mode=path-traced&measure=auto"),
    ).toBe(true);
  });

  it("drops unsupported values and unrelated query data", () => {
    expect(settingsFromSearch("?preset=other&mode=invalid")).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(
      sanitizedRenderQueryParams(
        "?preset=heavy&mode=restir&measure=auto&token=secret",
      ).toString(),
    ).toBe("preset=heavy&mode=restir&measure=auto");
    expect(shouldAutoMeasure("?measure=1")).toBe(false);
  });

  it("starts automatic comparisons in reference mode", () => {
    const search = "?preset=heavy&compare=path-traced";
    expect(settingsFromSearch(search)).toEqual({
      ...DEFAULT_SETTINGS,
      scene: "manyLights",
      mode: "reference",
      diCandidates: 32,
      spatialSamples: 8,
      maxBounces: 6,
      resolutionScale: 0.75,
    });
    expect(autoComparisonMode(search)).toBe("path-traced");
    expect(sanitizedRenderQueryParams(search).toString()).toBe(
      "preset=heavy&compare=path-traced",
    );
  });

  it("does not combine automatic comparison and performance capture", () => {
    const search = "?compare=restir&mode=path-traced&measure=auto";
    expect(sanitizedRenderQueryParams(search).toString()).toBe(
      "compare=restir",
    );
    expect(settingsFromSearch(search).mode).toBe("reference");
    expect(shouldAutoMeasure(search)).toBe(false);
    expect(autoComparisonMode("?compare=invalid")).toBeNull();
  });

  it("loads the paired comparison matrix as one self-contained preset", () => {
    const search =
      "?preset=matrix&compare=restir&mode=path-traced&measure=auto&token=secret";
    expect(settingsFromSearch(search)).toEqual({
      ...DEFAULT_SETTINGS,
      scene: "manyLights",
      mode: "reference",
      diCandidates: 32,
      spatialSamples: 8,
      maxBounces: 6,
      resolutionScale: 0.75,
    });
    expect(autoComparisonMode(search)).toBe("matrix");
    expect(shouldAutoMeasure(search)).toBe(false);
    expect(sanitizedRenderQueryParams(search).toString()).toBe("preset=matrix");
  });

  it("throttles the matrix to an allowlisted resolution scale", () => {
    const search = "?preset=matrix&scale=0.4";
    expect(settingsFromSearch(search)).toEqual({
      ...DEFAULT_SETTINGS,
      scene: "manyLights",
      mode: "reference",
      diCandidates: 32,
      spatialSamples: 8,
      maxBounces: 6,
      resolutionScale: 0.4,
    });
    expect(autoComparisonMode(search)).toBe("matrix");
    expect(sanitizedRenderQueryParams(search).toString()).toBe(
      "preset=matrix&scale=0.4",
    );
  });

  it("keeps every allowlisted scale a number the renderer can use", () => {
    for (const scale of MATRIX_RESOLUTION_SCALES) {
      const resolved = settingsFromSearch(
        `?preset=matrix&scale=${scale}`,
      ).resolutionScale;
      expect(resolved).toBe(Number(scale));
      expect(resolved).toBeGreaterThan(0);
      expect(resolved).toBeLessThanOrEqual(1);
    }
  });

  // An unrecognised scale must not read as a run at the preset's own scale, so
  // it leaves the URL the report records rather than silently rounding (#80).
  it("ignores a scale outside the allowlist", () => {
    for (const search of [
      "?preset=matrix&scale=0.42",
      "?preset=matrix&scale=0.4x",
      "?preset=matrix&scale=abc",
      "?preset=matrix&scale=",
      "?preset=matrix&scale=2",
      "?preset=matrix&scale=-0.4",
    ]) {
      expect(settingsFromSearch(search).resolutionScale).toBe(0.75);
      expect(sanitizedRenderQueryParams(search).toString()).toBe(
        "preset=matrix",
      );
    }
  });

  it("does not accept a scale outside the matrix preset", () => {
    expect(settingsFromSearch("?scale=0.4").resolutionScale).toBe(0.75);
    expect(settingsFromSearch("?preset=heavy&scale=0.4").resolutionScale).toBe(
      0.75,
    );
    expect(
      sanitizedRenderQueryParams("?preset=heavy&scale=0.4").toString(),
    ).toBe("preset=heavy");
  });
});

describe("packFlags", () => {
  it("sets every bit when all stages are on", () => {
    expect(packFlags(DEFAULT_SETTINGS)).toBe(
      FLAG_DI_ENABLED |
        FLAG_DI_TEMPORAL |
        FLAG_DI_SPATIAL |
        FLAG_GI_ENABLED |
        FLAG_GI_TEMPORAL |
        FLAG_GI_SPATIAL |
        FLAG_DENOISE,
    );
  });

  it("clears only the toggled stage", () => {
    const flags = packFlags({ ...DEFAULT_SETTINGS, giSpatial: false });
    expect(flags & FLAG_GI_SPATIAL).toBe(0);
    expect(flags & FLAG_GI_TEMPORAL).toBe(FLAG_GI_TEMPORAL);
  });
});

describe("requiresAccumulationReset", () => {
  it("resets when a sampling stage changes", () => {
    expect(
      requiresAccumulationReset(DEFAULT_SETTINGS, {
        ...DEFAULT_SETTINGS,
        diCandidates: 16,
      }),
    ).toBe(true);
  });

  // These only affect how the accumulated estimate is displayed or how far it
  // is allowed to run, so throwing away converged samples would be wasteful.
  it.each(["denoise", "exposure", "maxHistory"] as const)(
    "keeps history when %s changes",
    (key) => {
      const next = { ...DEFAULT_SETTINGS, [key]: DEFAULT_SETTINGS[key] };
      const changed =
        key === "denoise"
          ? { ...next, denoise: !DEFAULT_SETTINGS.denoise }
          : { ...next, [key]: DEFAULT_SETTINGS[key] + 1 };
      expect(requiresAccumulationReset(DEFAULT_SETTINGS, changed)).toBe(false);
    },
  );
});
