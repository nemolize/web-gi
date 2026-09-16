import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import {
  pathTarget,
  resamplePaths,
  reservoirRadiance,
} from "../src/gi/bdpt/resampling";
import { techniqueMisWeights } from "../src/gi/bdpt/weights";

const shader = readFileSync(
  new URL("../src/gi/shaders/bdpt-resampling.wgsl", import.meta.url),
  "utf8",
);

const entry = `
struct Result {
  radiance: vec4f,
  weights: vec4f,
  identity: vec4u,
  checks: vec4f,
}
@group(0) @binding(0) var<storage, read_write> results: array<Result>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  let mode = index % 4u;
  let random = (f32(index / 4u) + 0.5) / 256.0;
  var reservoir = bdptEmptyReservoir(7.0);
  let a = BdptPathSample(vec4u(2u, 3u, 123u, 456u), vec4f(2.0, 4.0, 1.0, 0.3));
  let b = BdptPathSample(vec4u(4u, 1u, 789u, 987u), vec4f(5.0, 1.0, 3.0, 0.7));
  if (mode == 0u) {
    bdptUpdateReservoir(&reservoir, a, 4.0, bdptInitialWeight(3u, 16u), 1.0, 0.5);
    bdptUpdateReservoir(&reservoir, b, 8.0, bdptInitialWeight(1u, 16u), 1.0, random);
  }
  if (mode == 1u) {
    bdptUpdateReservoir(&reservoir, a, 4.0, 0.25, 2.0, random);
  }
  if (mode == 2u) {
    var dark = a;
    dark.contributionMis.w = 0.0;
    bdptUpdateReservoir(&reservoir, dark, 4.0, 1.0, 1.0, random);
  }
  bdptFinalizeReservoir(&reservoir);
  var sum: BdptMisSum;
  let offset = select(0.0, -1000.0, index % 2u == 1u);
  bdptAccumulateMis(&sum, log(0.25) + offset, 1u, true);
  bdptAccumulateMis(&sum, log(0.5) + offset, 2u, true);
  bdptAccumulateMis(&sum, 0.0, 100u, false);
  bdptAccumulateMis(&sum, 0.0, 0u, true);
  let balanceA = bdptBalanceNumerator(1.0, 2.0, 1.0);
  let balanceB = bdptBalanceNumerator(4.0, 3.0, 0.5);
  results[index] = Result(
    vec4f(bdptReservoirRadiance(reservoir), bdptTarget(a)),
    vec4f(reservoir.weightSum, reservoir.contributionWeight, reservoir.confidence, reservoir.targetDensity),
    reservoir.sample.techniqueSeeds,
    vec4f(
      bdptMisWeight(sum, log(0.25) + offset, 1u, true),
      bdptMisWeight(sum, log(0.5) + offset, 2u, true),
      balanceA / (balanceA + balanceB),
      21.0 * bdptInitialWeight(1u, 100u)
    )
  );
}
`;

test("BDPT WGSL resampling agrees with the CPU estimator on a real device", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (code) => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener("uncapturederror", (event) =>
      errors.push(event.error.message),
    );
    try {
      device.pushErrorScope("validation");
      const module = device.createShaderModule({ code });
      const info = await module.getCompilationInfo();
      errors.push(
        ...info.messages
          .filter((message) => message.type === "error")
          .map((message) => message.message),
      );
      if (errors.length > 0) throw new Error(errors.join("\n"));
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      const size = 1024 * 64;
      const output = device.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const staging = device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: output } }],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(16);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const mapped = staging.getMappedRange();
      const floats = new Float32Array(mapped);
      const integers = new Uint32Array(mapped);
      const data = {
        floats: Array.from(floats),
        integers: Array.from(integers),
      };
      staging.unmap();
      const validation = await device.popErrorScope();
      if (validation) errors.push(validation.message);
      return { errors, ...data };
    } finally {
      device.destroy();
    }
  }, shader + entry);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  const a = {
    technique: { lightVertices: 2, cameraVertices: 3 },
    cameraSeed: 123,
    lightSeed: 456,
    contribution: { x: 2, y: 4, z: 1 },
    techniqueWeight: 0.3,
  };
  const b = {
    technique: { lightVertices: 4, cameraVertices: 1 },
    cameraSeed: 789,
    lightSeed: 987,
    contribution: { x: 5, y: 1, z: 3 },
    techniqueWeight: 0.7,
  };
  const { floats, integers } = result;
  let maximumError = 0;
  let identitiesMatch = true;
  const compare = (actual, expected) => {
    maximumError = Math.max(maximumError, Math.abs(actual - expected));
  };
  for (let index = 0; index < 1024; index++) {
    const mode = index % 4;
    const random = (Math.floor(index / 4) + 0.5) / 256;
    const candidate = {
      sample: a,
      contributionWeight: 4,
      resamplingWeight: 1,
      jacobian: 1,
    };
    const cases = [
      [
        candidate,
        {
          sample: b,
          contributionWeight: 8,
          resamplingWeight: 1 / 16,
          jacobian: 1,
        },
      ],
      [{ ...candidate, resamplingWeight: 0.25, jacobian: 2 }],
      [{ ...candidate, sample: { ...a, techniqueWeight: 0 } }],
      [],
    ];
    const reservoir = resamplePaths(cases[mode], 7, () => random);
    const rgb = reservoirRadiance(reservoir);
    const offset = index * 16;
    [rgb.x, rgb.y, rgb.z, pathTarget(a)].forEach((value, channel) =>
      compare(floats[offset + channel], value),
    );
    compare(floats[offset + 5], reservoir.contributionWeight);
    compare(floats[offset + 6], reservoir.confidence);
    const selected = reservoir.sample;
    const selectedTarget = selected ? pathTarget(selected) : 0;
    compare(floats[offset + 7], selectedTarget);
    compare(
      floats[offset + 4],
      cases[mode].reduce(
        (sum, value) =>
          sum +
          pathTarget(value.sample) *
            value.contributionWeight *
            value.resamplingWeight *
            value.jacobian,
        0,
      ),
    );
    const identity = selected
      ? [
          selected.technique.lightVertices,
          selected.technique.cameraVertices,
          selected.cameraSeed,
          selected.lightSeed,
        ]
      : [0, 0, 0, 0];
    identitiesMatch &&= identity.every(
      (value, channel) => integers[offset + 8 + channel] === value,
    );
    const weights = techniqueMisWeights([
      {
        technique: a.technique,
        logRelativeDensity: Math.log(0.25),
        sampleCount: 1,
      },
      {
        technique: b.technique,
        logRelativeDensity: Math.log(0.5),
        sampleCount: 2,
      },
    ]);
    [weights[0], weights[1], 0.25, 0.21].forEach((value, channel) =>
      compare(floats[offset + 12 + channel], value),
    );
  }
  expect(identitiesMatch).toBe(true);
  expect(maximumError).toBeLessThan(0.0001);
});
