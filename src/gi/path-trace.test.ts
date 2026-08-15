import captureWgsl from "@/gi/shaders/capture.wgsl?raw";
import gbufferWgsl from "@/gi/shaders/gbuffer.wgsl?raw";
import pathTraceWgsl from "@/gi/shaders/path-trace.wgsl?raw";
import referenceWgsl from "@/gi/shaders/reference.wgsl?raw";
import giWgsl from "@/gi/shaders/restir-gi.wgsl?raw";
import sceneWgsl from "@/gi/shaders/scene.wgsl?raw";
import shadeWgsl from "@/gi/shaders/shade.wgsl?raw";

describe("denoised path-tracing shader", () => {
  it("starts from the stable G-buffer and writes demodulated illumination", () => {
    expect(pathTraceWgsl).toContain("surfacePosition(uni.cam, pixel, depth)");
    expect(pathTraceWgsl).toContain("materialAlbedo(materialIndex)");
    expect(pathTraceWgsl).toContain("vec3f(MAX_ILLUMINATION)");
    expect(pathTraceWgsl).toContain("outIllumination");
    expect(pathTraceWgsl).not.toContain("traceScenePrimary");
  });

  it("traces glass spheres and boxes through reflection and refraction", () => {
    expect(sceneWgsl).toContain("intersectSphere");
    expect(sceneWgsl).toContain("intersectBox");
    expect(sceneWgsl).toContain("boxOutwardNormal");
    expect(sceneWgsl).toContain("fresnelReflectance");
    expect(sceneWgsl).toContain(
      "dir = glassScatterDirection(incoming, normal, eta, reflected)",
    );
    expect(shadeWgsl).toContain("materialIndex > 0u");
    expect(gbufferWgsl).toContain("hit.frontFace");
    expect(captureWgsl).toContain("fn glassDiagnostic");
    expect(captureWgsl).toContain(
      "glassScatterDirection(rd, entry.normal, entryEta, false)",
    );
    expect(captureWgsl).toMatch(
      /glassScatterDirection\(\s*insideDirection,\s*exit\.normal,\s*shape\.tintIor\.w,\s*false/,
    );
    expect(captureWgsl).toContain(
      "backdrop.hit && backdrop.materialIndex == 0u",
    );
    expect(pathTraceWgsl).toContain("packedNormal.w > 0.0");
    expect(giWgsl).toContain("hit.materialIndex == 0u");
    expect(sceneWgsl).toMatch(
      /fn traceOccluded[\s\S]*intersectGlassShape\(i, ro, rd, tMax\)/,
    );
  });

  it("keeps the independent progressive reference as the comparison oracle", () => {
    expect(referenceWgsl).toContain("traceScenePrimary");
    expect(referenceWgsl).toContain("texPrevAccum");
    expect(referenceWgsl).toContain("mix(previous.xyz, radiance, 1.0 / count)");
  });
});
