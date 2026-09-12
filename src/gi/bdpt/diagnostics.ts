import { bdptShaderPrefix } from "@/gi/bdpt/pipeline";
import type { DiagnosticSuite } from "@/gi/diagnostics/runner";
import initialCamera from "@/gi/shaders/bdpt-initial-camera.wgsl?raw";
import initialGather from "@/gi/shaders/bdpt-initial-gather.wgsl?raw";

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
    "paired-subpaths",
    probe(
      "var workspace: BdptWorkspace; bdptBuildCameraSubpath(uni.cam, vec2f(0.0), uni.frame, bdptVertexLimit() - 1u, &workspace.cameraPath); bdptBuildLightSubpath(uni.frame, bdptVertexLimit() - 2u, &workspace.lightPath); let a = workspace.cameraPath.vertices[uni.frame % max(1u, workspace.cameraPath.count)]; let b = workspace.lightPath.vertices[uni.frame % max(1u, workspace.lightPath.count)]; result[gid.x] = vec4f(a.throughput + b.throughput, f32(workspace.cameraPath.count + workspace.lightPath.count));",
    ),
  ],
  [
    "build-mis-path",
    probe(
      "var workspace: BdptWorkspace; bdptBuildCameraSubpath(uni.cam, vec2f(0.0), uni.frame, bdptVertexLimit() - 1u, &workspace.cameraPath); bdptBuildLightSubpath(uni.frame, bdptVertexLimit() - 2u, &workspace.lightPath); let t = 2u + uni.frame % max(1u, workspace.cameraPath.count); let s = (uni.frame / 17u) % (min(workspace.lightPath.count, bdptVertexLimit() - t) + 1u); bdptBuildMisPath(uni.cam, t, s, &workspace); result[gid.x] = vec4f(workspace.misPath.vertices[uni.frame % max(1u, workspace.misPath.count)].position, workspace.misPath.emitterPdfArea);",
    ),
  ],
  [
    "visibility",
    probe(
      "let visible = mutuallyVisible(uni.cam.pos.xyz, uni.cam.forward.xyz, quads[uni.frame % uni.quadCount].origin.xyz); result[gid.x] = vec4f(select(0.0, 1.0, visible));",
    ),
  ],
  [
    "surface-connection",
    probe(
      "var a: BdptVertex; var b: BdptVertex; let qa = quads[uni.frame % uni.quadCount]; let qb = quads[(uni.frame + 1u) % uni.quadCount]; a.surface.pos = qa.origin.xyz; a.surface.normal = qa.normal.xyz; a.surface.albedo = vec3f(0.5); a.throughput = vec3f(1.0); b.surface.pos = qb.origin.xyz; b.surface.normal = qb.normal.xyz; b.surface.albedo = vec3f(0.5); b.throughput = vec3f(1.0); result[gid.x] = vec4f(bdptConnectSurfaces(&a, &b, (uni.frame & 1u) != 0u), 1.0);",
    ),
  ],
  [
    "camera-connection",
    probe(
      "var vertex: BdptVertex; let quad = quads[uni.frame % uni.quadCount]; vertex.surface.pos = quad.origin.xyz; vertex.surface.normal = quad.normal.xyz; vertex.surface.albedo = vec3f(0.5); vertex.throughput = vec3f(1.0); result[gid.x] = vec4f(bdptConnectCamera(uni.cam, &vertex, (uni.frame & 1u) != 0u), 1.0);",
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

const bindings: Omit<GPUBindGroupLayoutEntry, "visibility">[][] = [
  Array.from({ length: 5 }, (_, binding) => ({
    binding,
    buffer: { type: binding === 0 ? "uniform" : "read-only-storage" },
  })),
  [{ binding: 0, buffer: { type: "storage" } }],
];

export const bdptDiagnosticSuite: DiagnosticSuite = {
  id: "bdpt",
  label: "ReSTIR BDPT",
  version: 5,
  description:
    "Smaller arrays and omitted MIS are diagnostic variations, not renderer settings or fixes.",
  probes: [
    ...[8, 4, 1].map((size) => ({
      label: `initial-gather / workgroup=${size}x${size}`,
      code: `${bdptShaderPrefix}\n${initialGather}`,
      bindings: [
        ...bindings.slice(0, 1),
        [0, 1, 2, 3].map((binding) => ({
          binding,
          buffer: {
            type:
              binding === 3
                ? ("storage" as const)
                : ("read-only-storage" as const),
          },
        })),
      ],
      constants: { BDPT_WORKGROUP_SIZE: size },
    })),
    ...[32, 8].flatMap((vertices) =>
      stages.map(([stage, body]) => {
        const source =
          stage === "candidate-no-mis"
            ? bdptShaderPrefix.replace(
                "candidate.misWeight = bdptTechniqueWeight(camera, path, cameraVertices, lightSubpathCount);",
                "candidate.misWeight = 1.0;",
              )
            : bdptShaderPrefix;
        return {
          label: `${stage} / vertices=${vertices} / workgroup=1`,
          code: `${source.replace("const BDPT_MAX_VERTICES: u32 = 32u;", `const BDPT_MAX_VERTICES: u32 = ${vertices}u;`)}\n${body}`,
          bindings,
          constants: { BDPT_WORKGROUP_SIZE: 1 },
        };
      }),
    ),
  ],
};
