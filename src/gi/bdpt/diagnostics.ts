import { bdptShaderPrefix } from "@/gi/bdpt/pipeline";
import initialCamera from "@/gi/shaders/bdpt-initial-camera.wgsl?raw";

const probe = (body: string) => `
@group(1) @binding(0) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(BDPT_WORKGROUP_SIZE, BDPT_WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  ${body}
}`;

const stages = [
  [
    "primary-hit",
    probe(
      "let hit = traceScenePrimary(uni.cam.pos.xyz, primaryRayDir(uni.cam, vec2f(0.0))); result[gid.x] = vec4f(hit.pos, hit.t);",
    ),
  ],
  [
    "camera-subpath",
    probe(
      "var path: BdptSubpath; bdptBuildCameraSubpath(uni.cam, vec2f(0.0), uni.frame, bdptVertexLimit() - 1u, &path); result[gid.x] = vec4f(path.vertices[uni.frame % max(1u, path.count)].throughput, f32(path.count));",
    ),
  ],
  [
    "light-subpath",
    probe(
      "var path: BdptSubpath; bdptBuildLightSubpath(uni.frame, bdptVertexLimit() - 1u, &path); result[gid.x] = vec4f(path.vertices[uni.frame % max(1u, path.count)].throughput, f32(path.count));",
    ),
  ],
  [
    "mis-only",
    probe(
      "var path: BdptMisPath; path.count = min(BDPT_MAX_VERTICES, max(2u, uni.maxBounces + 2u)); path.emitterPdfArea = 1.0; for (var index = 0u; index < path.count; index++) { let quad = quads[index % uni.quadCount]; path.vertices[index] = BdptMisVertex(quad.origin.xyz, quad.normal.xyz, false); } result[gid.x] = vec4f(bdptTechniqueWeight(uni.cam, &path, 1u + uni.frame % path.count, uni.resolution.x * uni.resolution.y));",
    ),
  ],
  [
    "candidate-no-mis",
    probe(
      "var workspace: BdptWorkspace; bdptBuildCameraSubpath(uni.cam, vec2f(0.0), uni.frame, bdptVertexLimit() - 1u, &workspace.cameraPath); bdptBuildLightSubpath(uni.frame, bdptVertexLimit() - 2u, &workspace.lightPath); let t = 2u + uni.frame % max(1u, workspace.cameraPath.count); let s = (uni.frame / 17u) % (min(workspace.lightPath.count, bdptVertexLimit() - t) + 1u); let candidate = bdptEvaluateCandidate(uni.cam, t, s, gid.xy, uni.resolution.x * uni.resolution.y, &workspace); result[gid.x] = vec4f(candidate.estimator, candidate.misWeight);",
    ),
  ],
  [
    "candidate-mis",
    probe(
      "var workspace: BdptWorkspace; bdptBuildCameraSubpath(uni.cam, vec2f(0.0), uni.frame, bdptVertexLimit() - 1u, &workspace.cameraPath); bdptBuildLightSubpath(uni.frame, bdptVertexLimit() - 2u, &workspace.lightPath); let t = 2u + uni.frame % max(1u, workspace.cameraPath.count); let s = (uni.frame / 17u) % (min(workspace.lightPath.count, bdptVertexLimit() - t) + 1u); let candidate = bdptEvaluateCandidate(uni.cam, t, s, gid.xy, uni.resolution.x * uni.resolution.y, &workspace); result[gid.x] = vec4f(candidate.estimator, candidate.misWeight);",
    ),
  ],
  ["initial-camera", initialCamera],
] as const;

export const runBdptDiagnostics = async (
  report: (line: string) => void,
  signal: AbortSignal,
): Promise<void> => {
  report("BDPT compiler diagnostics v2 (compilation only; no rendering)");
  report(`Browser: ${navigator.userAgent}`);
  const adapter = await navigator.gpu?.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("No WebGPU adapter available.");
  if (signal.aborted) return;
  const {
    vendor,
    architecture,
    device: adapterDevice,
    description,
  } = adapter.info;
  report(
    `Adapter: ${JSON.stringify({ vendor, architecture, device: adapterDevice, description })}`,
  );
  const device = await adapter.requestDevice();
  let loss: GPUDeviceLostInfo | null = null;
  void device.lost.then((info) => {
    loss = info;
    return info;
  });
  const cancel = () => device.destroy();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) return;
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [
        device.createBindGroupLayout({
          entries: Array.from({ length: 5 }, (_, binding) => ({
            binding,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: binding === 0 ? "uniform" : "read-only-storage" },
          })),
        }),
        device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.COMPUTE,
              buffer: { type: "storage" },
            },
          ],
        }),
      ],
    });
    for (const vertices of [32, 8]) {
      for (const [stage, body] of stages) {
        if (signal.aborted) return;
        const source =
          stage === "candidate-no-mis"
            ? bdptShaderPrefix.replace(
                "candidate.misWeight = bdptTechniqueWeight(camera, path, cameraVertices, lightSubpathCount);",
                "candidate.misWeight = 1.0;",
              )
            : bdptShaderPrefix;
        const label = `${stage} / vertices=${vertices} / workgroup=1`;
        report(`START ${label}`);
        const started = performance.now();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutError = new Error(
          "Compilation timed out after 30 seconds; diagnostics stopped.",
        );
        let abortWait: (() => void) | undefined;
        try {
          const result = await Promise.race([
            device.lost,
            new Promise<never>((_, reject) => {
              abortWait = () => reject(new Error("Stopped."));
              signal.addEventListener("abort", abortWait, { once: true });
            }),
            (async () => {
              const module = device.createShaderModule({
                label,
                code: `${source.replace("const BDPT_MAX_VERTICES: u32 = 32u;", `const BDPT_MAX_VERTICES: u32 = ${vertices}u;`)}\n${body}`,
              });
              const info = await module.getCompilationInfo();
              const errors = info.messages.filter(
                (message) => message.type === "error",
              );
              if (errors.length)
                throw new Error(
                  errors.map((message) => message.message).join("\n"),
                );
              await device.createComputePipelineAsync({
                label,
                layout,
                compute: {
                  module,
                  entryPoint: "main",
                  constants: { BDPT_WORKGROUP_SIZE: 1 },
                },
              });
            })(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(timeoutError), 30_000);
            }),
          ]);
          const lostInfo = result ?? loss;
          if (lostInfo)
            throw new Error(
              `GPU device lost (${lostInfo.reason}): ${lostInfo.message}`,
            );
          report(
            `PASS ${label} (${Math.round(performance.now() - started)} ms)`,
          );
        } catch (error) {
          if (signal.aborted) return;
          report(`FAIL ${label}: ${String(error)}`);
          if (error === timeoutError || loss !== null) return;
        } finally {
          clearTimeout(timeout);
          if (abortWait) signal.removeEventListener("abort", abortWait);
        }
      }
    }
    report(
      "DONE. The 8-vertex cases are diagnostic probes, not a renderer setting or a BDPT fix.",
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    device.destroy();
  }
};
