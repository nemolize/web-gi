import {
  COMPARISON_MATRIX_BUDGET,
  COMPARISON_MATRIX_PROBE_BUDGET,
} from "@/gi/comparison-matrix";
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
  MATRIX_ATROUS_TANGENT_SIGMAS,
  MATRIX_RESOLUTION_SCALES,
  MATRIX_SPATIAL_RADII,
  MATRIX_SPATIAL_SAMPLES,
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

  it("loads the probe preset like the matrix, on the same settings", () => {
    const search = "?preset=probe";
    expect(settingsFromSearch(search)).toEqual(
      settingsFromSearch("?preset=matrix"),
    );
    expect(autoComparisonMode(search)).toBe("probe");
    expect(sanitizedRenderQueryParams(search).toString()).toBe("preset=probe");
  });

  it("takes the same overrides on the probe preset", () => {
    const search = "?preset=probe&scale=0.25&radius=0.02&samples=0";
    const settings = settingsFromSearch(search);
    expect(settings.resolutionScale).toBe(0.25);
    expect(settings.spatialRadius).toBe(0.02);
    expect(settings.spatialSamples).toBe(0);
    expect(sanitizedRenderQueryParams(search).toString()).toBe(
      "preset=probe&scale=0.25&radius=0.02&samples=0",
    );
  });

  // The probe trades away dispersion and oracle accuracy, so a run recorded
  // under it must not read as one recorded under the matrix budget.
  it("keeps the probe budget cheaper and distinguishable", () => {
    expect(COMPARISON_MATRIX_PROBE_BUDGET.repeats).toBeLessThan(
      COMPARISON_MATRIX_BUDGET.repeats,
    );
    expect(COMPARISON_MATRIX_PROBE_BUDGET.referenceFrames).toBeLessThan(
      COMPARISON_MATRIX_BUDGET.referenceFrames,
    );
    expect(COMPARISON_MATRIX_PROBE_BUDGET.durationMs).toBeLessThan(
      COMPARISON_MATRIX_BUDGET.durationMs,
    );
    expect(COMPARISON_MATRIX_PROBE_BUDGET.repeats % 2).toBe(0);
  });

  it("overrides the spatial reuse radius for the matrix", () => {
    const search = "?preset=matrix&radius=0.02";
    expect(settingsFromSearch(search).spatialRadius).toBe(0.02);
    expect(sanitizedRenderQueryParams(search).toString()).toBe(
      "preset=matrix&radius=0.02",
    );
  });

  it("overrides the a-trous tangential sigma for the matrix", () => {
    const search = "?preset=matrix&tangent=0.32";
    expect(settingsFromSearch("?preset=matrix").atrousTangentSigma).toBe(0.08);
    expect(settingsFromSearch(search).atrousTangentSigma).toBe(0.32);
    expect(sanitizedRenderQueryParams(search).toString()).toBe(
      "preset=matrix&tangent=0.32",
    );
  });

  it("keeps every allowlisted tangential sigma usable by the renderer", () => {
    for (const sigma of MATRIX_ATROUS_TANGENT_SIGMAS) {
      const resolved = settingsFromSearch(
        `?preset=matrix&tangent=${sigma}`,
      ).atrousTangentSigma;
      expect(resolved).toBe(Number(sigma));
      expect(resolved).toBeGreaterThan(0);
    }
  });

  it("ignores a tangential sigma outside the allowlist", () => {
    for (const search of [
      "?preset=matrix&tangent=0.05",
      "?preset=matrix&tangent=0.08m",
      "?preset=matrix&tangent=abc",
      "?preset=matrix&tangent=",
      "?preset=matrix&tangent=-0.08",
      "?preset=matrix&tangent=0",
    ]) {
      expect(settingsFromSearch(search).atrousTangentSigma).toBe(0.08);
      expect(sanitizedRenderQueryParams(search).toString()).toBe(
        "preset=matrix",
      );
    }
  });

  it("keeps every allowlisted radius a number the renderer can use", () => {
    for (const radius of MATRIX_SPATIAL_RADII) {
      const resolved = settingsFromSearch(
        `?preset=matrix&radius=${radius}`,
      ).spatialRadius;
      expect(resolved).toBe(Number(radius));
      expect(resolved).toBeGreaterThan(0);
    }
  });

  it("combines every matrix override", () => {
    const search = "?preset=matrix&scale=0.25&radius=0.02&samples=0";
    const settings = settingsFromSearch(search);
    expect(settings.resolutionScale).toBe(0.25);
    expect(settings.spatialRadius).toBe(0.02);
    expect(settings.spatialSamples).toBe(0);
    expect(sanitizedRenderQueryParams(search).toString()).toBe(
      "preset=matrix&scale=0.25&radius=0.02&samples=0",
    );
  });

  it("overrides the neighbour count the matrix preset would otherwise set (#90's discriminator)", () => {
    const search = "?preset=matrix&samples=0";
    expect(settingsFromSearch("?preset=matrix").spatialSamples).toBe(8);
    expect(settingsFromSearch(search).spatialSamples).toBe(0);
    expect(sanitizedRenderQueryParams(search).toString()).toBe(
      "preset=matrix&samples=0",
    );
  });

  it("keeps every allowlisted neighbour count a number the renderer can use", () => {
    for (const samples of MATRIX_SPATIAL_SAMPLES) {
      const resolved = settingsFromSearch(
        `?preset=matrix&samples=${samples}`,
      ).spatialSamples;
      expect(resolved).toBe(Number(samples));
      expect(Number.isInteger(resolved)).toBe(true);
      expect(resolved).toBeGreaterThanOrEqual(0);
    }
  });

  it("ignores a neighbour count outside the allowlist", () => {
    for (const search of [
      "?preset=matrix&samples=3",
      "?preset=matrix&samples=16",
      "?preset=matrix&samples=0px",
      "?preset=matrix&samples=abc",
      "?preset=matrix&samples=",
      "?preset=matrix&samples=-1",
    ]) {
      expect(settingsFromSearch(search).spatialSamples).toBe(8);
      expect(sanitizedRenderQueryParams(search).toString()).toBe(
        "preset=matrix",
      );
    }
  });

  it("does not accept a neighbour count outside the matrix preset", () => {
    expect(settingsFromSearch("?samples=0").spatialSamples).toBe(4);
    expect(settingsFromSearch("?preset=heavy&samples=0").spatialSamples).toBe(
      8,
    );
  });

  it("ignores a radius outside the allowlist", () => {
    for (const search of [
      "?preset=matrix&radius=7",
      "?preset=matrix&radius=8px",
      "?preset=matrix&radius=abc",
      "?preset=matrix&radius=",
      "?preset=matrix&radius=-8",
    ]) {
      expect(settingsFromSearch(search).spatialRadius).toBe(0.04);
      expect(sanitizedRenderQueryParams(search).toString()).toBe(
        "preset=matrix",
      );
    }
  });

  // The value is allowlisted, so only the preset gate can be rejecting it.
  it("does not accept a radius outside the matrix preset", () => {
    expect(settingsFromSearch("?radius=0.02").spatialRadius).toBe(0.04);
    expect(settingsFromSearch("?preset=heavy&radius=0.02").spatialRadius).toBe(
      0.04,
    );
  });

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
