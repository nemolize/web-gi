import { bdptShaderPrefix } from "@/gi/bdpt/pipeline";
import type { DiagnosticSuite } from "@/gi/diagnostics/runner";

const prefix = bdptShaderPrefix.replace(
  "const BDPT_MAX_VERTICES: u32 = 32u;",
  "const BDPT_MAX_VERTICES: u32 = 10u;",
);
if (prefix === bdptShaderPrefix)
  throw new Error(
    "BDPT inverse diagnostic vertex capacity no longer matches production.",
  );

const declarations = `
struct DiagnosticPrepared {
  sample: BdptReplaySample,
  estimatorMis: vec4f,
  pixel: vec2u,
  pdfAreas: vec2f,
  film: vec2f,
  caustic: u32,
  connection: u32,
  pdf: f32,
}
@group(1) @binding(0) var<storage, read> inputs: array<DiagnosticPrepared>;
@group(1) @binding(1) var<storage, read_write> outputs: array<DiagnosticPrepared>;

fn storePrepared(index: u32, prepared: BdptShiftSource) {
  outputs[index] = DiagnosticPrepared(prepared.sample,
    vec4f(prepared.evaluation.candidate.estimator, prepared.evaluation.candidate.misWeight),
    prepared.evaluation.candidate.pixel,
    vec2f(prepared.evaluation.lightPdfArea, prepared.evaluation.cameraPdfArea),
    prepared.evaluation.film, select(0u, 1u, prepared.evaluation.caustic),
    prepared.connection, prepared.pdf);
}

@compute @workgroup_size(BDPT_WORKGROUP_SIZE, BDPT_WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid.xy >= uni.resolution)) { return; }
  let index = gid.y * uni.resolution.x + gid.x;
  let input = inputs[index];
  var workspace: BdptWorkspace;
`;

const loadPrepared = `
  var prepared: BdptShiftSource;
  prepared.sample = input.sample;
  prepared.evaluation.candidate = BdptCandidate(input.estimatorMis.xyz, input.estimatorMis.w, input.pixel);
  prepared.evaluation.lightPdfArea = input.pdfAreas.x;
  prepared.evaluation.cameraPdfArea = input.pdfAreas.y;
  prepared.evaluation.film = input.film;
  prepared.evaluation.caustic = input.caustic != 0u;
  prepared.connection = input.connection;
  prepared.pdf = input.pdf;
`;

export const bdptInverseCompileSuites: DiagnosticSuite[] = [
  {
    id: "bdpt-inverse-prepare",
    label: "BDPT inverse: preparation only",
    body: `
  let prepared = bdptPrepareShift(input.sample, uni.cam, gid.xy, uni.resolution.x * uni.resolution.y, &workspace);
  storePrepared(index, prepared);
`,
  },
  {
    id: "bdpt-inverse-apply",
    label: "BDPT inverse: application only (synthetic input)",
    body: `${loadPrepared}
  let shifted = bdptApplyShift(prepared, uni.cam, uni.cam, gid.xy, input.sample.techniqueSeeds.zw, uni.resolution.x * uni.resolution.y, &workspace);
  var result: BdptShiftSource;
  result.sample = shifted.sample;
  result.evaluation = shifted.evaluation;
  result.pdf = shifted.jacobian;
  storePrepared(index, result);
`,
  },
].map(({ id, label, body }) => ({
  id,
  label,
  version: 1,
  description:
    "Compile one isolated inverse helper, with 10 vertices and a 1x1 workgroup. Runtime storage inputs and output writes retain relevant data flow. Application uses synthetic prepared metadata, not a valid rendered path. No dispatch, buffers, neighbor loop, or earlier pipelines. Cache reuse remains possible.",
  probes: [
    {
      label: `${id} / vertices=10 / workgroup=1x1`,
      code: `${prefix}\n${declarations}\n${body}\n}`,
      bindings: [
        Array.from({ length: 5 }, (_, binding) => ({
          binding,
          buffer: { type: binding === 0 ? "uniform" : "read-only-storage" },
        })),
        [
          { binding: 0, buffer: { type: "read-only-storage" } },
          { binding: 1, buffer: { type: "storage" } },
        ],
        [{ binding: 0, buffer: { type: "uniform", hasDynamicOffset: true } }],
      ],
      constants: { BDPT_WORKGROUP_SIZE: 1 },
    },
  ],
}));
