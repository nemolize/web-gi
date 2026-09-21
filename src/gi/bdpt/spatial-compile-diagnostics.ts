import { bdptShaderPrefix } from "@/gi/bdpt/pipeline";
import type { DiagnosticSuite } from "@/gi/diagnostics/runner";
import spatial from "@/gi/shaders/bdpt-spatial.wgsl?raw";
import temporal from "@/gi/shaders/bdpt-temporal.wgsl?raw";

const replaceOnce = (source: string, before: string, after: string): string => {
  if (source.split(before).length !== 2)
    throw new Error(
      "BDPT spatial diagnostic source no longer matches production.",
    );
  return source.replace(before, after);
};

const prepareInverse =
  "  var preparedCenter: BdptShiftSource;\n  if (centerTarget > 0.0) {\n    preparedCenter = bdptPrepareShift(bdptReservoirSample(center.normal), uni.cam, pixel, lightCount, &workspace);\n  }\n";

const applyInverse =
  "    if (centerTarget > 0.0 && source.path.confidence > 0.0) {\n      let inverse = bdptApplyShift(preparedCenter, uni.cam, uni.cam, pixel, sourcePixel, lightCount, &workspace);\n      let inverseSample = BdptPathSample(inverse.sample.techniqueSeeds,\n        vec4f(inverse.evaluation.candidate.estimator, inverse.evaluation.candidate.misWeight));\n      let other = bdptBalanceNumerator(source.path.confidence, bdptTarget(inverseSample), inverse.jacobian);\n      centerPairWeight = bdptPairwiseWeight(centerConfidence * centerTarget, other);\n    }\n";

const applyForward =
  "    if (source.path.targetDensity <= 0.0 || source.path.confidence <= 0.0) { continue; }\n    let shifted = bdptShiftReplay(bdptReservoirSample(source), uni.cam, sourcePixel, pixel, lightCount, &workspace);\n    if (shifted.jacobian <= 0.0) { continue; }\n    let shiftedSample = BdptPathSample(shifted.sample.techniqueSeeds,\n      vec4f(shifted.evaluation.candidate.estimator, shifted.evaluation.candidate.misWeight));\n    let own = bdptBalanceNumerator(source.path.confidence, source.path.targetDensity, 1.0 / shifted.jacobian);\n    let weight = bdptPairwiseWeight(own, centerConfidence * bdptTarget(shiftedSample)) / f32(count);\n    gRngState = selectionState;\n    let random = bdptRandom();\n    selectionState = gRngState;\n    bdptUpdateReplayReservoir(&output, shifted.sample, shifted.evaluation.candidate,\n      source.path.contributionWeight, weight, shifted.jacobian, random);";

const withoutInverse = replaceOnce(
  replaceOnce(spatial, prepareInverse, ""),
  applyInverse,
  "",
);
const withoutForward = replaceOnce(spatial, applyForward, "");
const variants = [
  ["full", "production spatial alone", spatial],
  ["no-inverse", "without inverse replay", withoutInverse],
  ["no-forward", "without forward replay", withoutForward],
  [
    "no-replay",
    "without either replay",
    replaceOnce(withoutInverse, applyForward, ""),
  ],
  [
    "one-neighbor",
    "one neighbor iteration",
    replaceOnce(spatial, "sourceIndex < count", "sourceIndex < 2u"),
  ],
  [
    "inverse-one-neighbor",
    "inverse replay with one neighbor iteration",
    replaceOnce(withoutForward, "sourceIndex < count", "sourceIndex < 2u"),
  ],
] as const;

export const bdptSpatialCompileSuites: DiagnosticSuite[] = variants.map(
  ([id, label, body]) => ({
    id: `bdpt-spatial-${id}`,
    label: `BDPT spatial: ${label}`,
    version: 1,
    description:
      "One compilation per Run on a new device, with 10 vertices and a 1x1 workgroup. No rendering or earlier BDPT pipelines. Variants are compiler probes, not correct rendering modes. Restart the browser after device loss before comparing another variant.",
    probes: [
      {
        label: `spatial-${id} / vertices=10 / workgroup=1x1`,
        code: `${replaceOnce(bdptShaderPrefix, "const BDPT_MAX_VERTICES: u32 = 32u;", "const BDPT_MAX_VERTICES: u32 = 10u;")}\n${body}`,
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
  }),
);

const fullSpatial = bdptSpatialCompileSuites[0]?.probes[0];
if (!fullSpatial || !("code" in fullSpatial))
  throw new Error("Expected a spatial compiler probe.");

const [sceneBindings, , dispatchBindings] = fullSpatial.bindings;
if (!sceneBindings || !dispatchBindings)
  throw new Error("Missing compiler bindings.");

const temporalThenSpatial: DiagnosticSuite = {
  id: "bdpt-spatial-after-temporal",
  label: "BDPT spatial: temporal then spatial",
  version: 1,
  retainPipelines: true,
  stopOnFailure: true,
  description:
    "Compile temporal then full spatial on the same new device, retaining the temporal pipeline. Both use 10 vertices and a 1x1 workgroup. No buffers, rendering, or dispatches. Browser/compiler caches may survive a restart; success does not prove a fresh compilation.",
  probes: [
    {
      ...fullSpatial,
      label: "temporal / vertices=10 / workgroup=1x1",
      code: `${replaceOnce(bdptShaderPrefix, "const BDPT_MAX_VERTICES: u32 = 32u;", "const BDPT_MAX_VERTICES: u32 = 10u;")}\n${temporal}`,
      bindings: [
        sceneBindings,
        [0, 1, 2, 3].map((binding) => ({
          binding,
          buffer: { type: binding < 2 ? "read-only-storage" : "storage" },
        })),
        dispatchBindings,
      ],
    },
    fullSpatial,
  ],
};

bdptSpatialCompileSuites.push(temporalThenSpatial, {
  ...temporalThenSpatial,
  id: "bdpt-temporal-after-spatial",
  label: "BDPT spatial: spatial then temporal",
  description:
    "Compile full spatial then temporal on the same new device, retaining the spatial pipeline. Both use 10 vertices and a 1x1 workgroup. No buffers, rendering, or dispatches. Browser/compiler caches may survive a restart; success does not prove a fresh compilation.",
  probes: [...temporalThenSpatial.probes].reverse(),
});
