import pathTraceWgsl from "@/gi/shaders/path-trace.wgsl?raw";
import referenceWgsl from "@/gi/shaders/reference.wgsl?raw";

describe("denoised path-tracing shader", () => {
  it("starts from the stable G-buffer and writes demodulated illumination", () => {
    expect(pathTraceWgsl).toContain("surfacePosition(uni.cam, pixel, depth)");
    expect(pathTraceWgsl).toContain("vec3f(1.0)");
    expect(pathTraceWgsl).toContain("vec3f(MAX_ILLUMINATION)");
    expect(pathTraceWgsl).toContain("outIllumination");
    expect(pathTraceWgsl).not.toContain("traceScenePrimary");
  });

  it("keeps the independent progressive reference as the comparison oracle", () => {
    expect(referenceWgsl).toContain("traceScenePrimary");
    expect(referenceWgsl).toContain("texPrevAccum");
    expect(referenceWgsl).toContain("mix(previous.xyz, radiance, 1.0 / count)");
  });
});
