import { assembleRendererPipelines } from "@/gi/renderer";
import { MATRIX_SPATIAL_SAMPLES } from "@/gi/settings";

it.each(["getDiSpatialPipeline", "getGiSpatialPipeline"])(
  "%s preserves standard capacity and caches the extended pipeline",
  (getter) => {
    const layouts = Object.fromEntries(
      [
        "gbuffer",
        "resample",
        "spatial",
        "shade",
        "pathTrace",
        "reference",
        "temporal",
        "atrous",
        "presentRestir",
        "presentReference",
      ].map((label) => [label, { label }]),
    );
    const compiled = [];
    const pipelines = assembleRendererPipelines(
      layouts,
      false,
      (label, body) => {
        const pipeline = { label, body };
        compiled.push(pipeline);
        return pipeline;
      },
      (label) => ({ label }),
    );
    expect(compiled.some(({ label }) => label.endsWith("-32"))).toBe(false);
    const standard = pipelines[getter](8);
    expect(standard.body).toContain("const MAX_NEIGHBORS: u32 = 8u;");
    for (const samples of MATRIX_SPATIAL_SAMPLES.map(Number)) {
      const pipeline = pipelines[getter](samples);
      const capacity = Number(
        /const MAX_NEIGHBORS: u32 = (\d+)u;/.exec(pipeline.body)?.[1],
      );
      expect(capacity).toBeGreaterThanOrEqual(samples);
      if (samples <= 8) expect(pipeline).toBe(standard);
    }
    const extended = pipelines[getter](32);
    expect(pipelines[getter](16)).toBe(extended);
    expect(pipelines[getter](0)).toBe(standard);
    expect(pipelines[getter](32)).toBe(extended);
    expect(compiled.filter(({ label }) => label.endsWith("-32"))).toHaveLength(
      1,
    );
  },
);
