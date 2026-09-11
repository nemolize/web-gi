import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { runBdptProbe } from "./bdpt-fixture";

const shader = [
  "common",
  "scene",
  "bdpt-resampling",
  "bdpt-transport",
  "bdpt-subpath",
  "bdpt-camera",
  "bdpt-mis",
  "bdpt-candidate",
  "bdpt-replay",
]
  .map((name) =>
    readFileSync(
      new URL(`../src/gi/shaders/${name}.wgsl`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");

const entry = `
struct Result { forward: vec4f, reverse: vec4f, caustic: vec4f, camera: vec4f }
@group(1) @binding(0) var<storage, read_write> results: array<Result>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var workspace: BdptWorkspace;
  let sample = BdptReplaySample(vec4u(2u, 1u, 0u, id.x + 37u), vec4f(0.0));
  let source = bdptReplay(sample, uni.cam, vec2u(0u), 64u, &workspace);
  let sourcePixel = source.candidate.pixel;
  let destination = vec2u((sourcePixel.x + 1u) % uni.resolution.x, sourcePixel.y);
  let shifted = bdptShiftReplay(sample, uni.cam, sourcePixel, destination, 64u, &workspace);
  let restored = bdptShiftReplay(shifted.sample, uni.cam, destination, sourcePixel, 64u, &workspace);
  var expected = 0.0;
  let eligible = shifted.jacobian > 0.0 && source.endpoint.quadIndex == 0u && shifted.evaluation.endpoint.quadIndex == 0u;
  if (eligible) {
    let a = source.endpoint.pos - source.predecessor.pos;
    let b = shifted.evaluation.endpoint.pos - source.predecessor.pos;
    expected = pow(dot(a, a) / dot(b, b), 2.0);
  }
  var camera = uni.cam;
  camera.pos.x = 1.3;
  camera.pos.w = 1.2;
  let causticSample = BdptReplaySample(vec4u(4u, 1u, 0u, id.x + 37u), vec4f(0.0));
  let caustic = bdptReplay(causticSample, camera, vec2u(0u), 64u, &workspace);
  let causticPixel = caustic.candidate.pixel;
  let causticShift = bdptShiftReplay(causticSample, camera, causticPixel, vec2u((causticPixel.x + 1u) % uni.resolution.x, causticPixel.y), 64u, &workspace);
  let causticReplay = bdptShiftReplay(causticSample, camera, causticPixel, causticPixel, 64u, &workspace);
  let cameraSample = BdptReplaySample(vec4u(1u, 2u, id.x + 19u, id.x + 37u), vec4f(0.0));
  let moved = bdptShiftReplay(cameraSample, uni.cam, vec2u(0u), vec2u(3u, 3u), 64u, &workspace);
  results[id.x] = Result(
    vec4f(select(0.0, 1.0, eligible), shifted.jacobian, expected, shifted.evaluation.candidate.misWeight),
    vec4f(restored.jacobian, length(restored.evaluation.endpoint.pos - source.endpoint.pos),
      select(0.0, 1.0, all(shifted.sample.techniqueSeeds == sample.techniqueSeeds)),
      select(0.0, 1.0, all(shifted.evaluation.candidate.pixel == destination))),
    vec4f(select(0.0, 1.0, caustic.caustic && maxComponent(caustic.candidate.estimator) > 0.0),
      causticShift.jacobian, causticReplay.jacobian, caustic.candidate.misWeight),
    vec4f(moved.jacobian, select(0.0, 1.0, all(moved.sample.techniqueSeeds == cameraSample.techniqueSeeds)),
      select(0.0, 1.0, all(moved.evaluation.candidate.pixel == vec2u(3u, 3u))), moved.evaluation.candidate.misWeight));
}
`;

test("BDPT shifts invertible light connections and keeps caustics out of spatial reuse", async ({
  page,
}) => {
  await page.goto("/");
  const result = await runBdptProbe(page, shader + entry, 16, true);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  let shiftedCount = 0;
  let causticCount = 0;
  for (let index = 0; index < 1024; index++) {
    const row = result.data.slice(index * 16, (index + 1) * 16);
    expect(row.every(Number.isFinite)).toBe(true);
    if (row[0] === 1) {
      shiftedCount++;
      expect(row[1]).toBeCloseTo(row[2], 4);
      expect(row[1] * row[4]).toBeCloseTo(1, 4);
      expect(row[5]).toBeLessThan(0.0001);
      expect(row.slice(6, 8)).toEqual([1, 1]);
    }
    if (row[8] === 1) {
      causticCount++;
      expect(row.slice(9, 11)).toEqual([0, 1]);
      expect(row[11]).toBeGreaterThan(0);
    }
    expect(row.slice(12, 15)).toEqual([1, 1, 1]);
    expect(row[15]).toBeGreaterThanOrEqual(0);
    expect(row[15]).toBeLessThanOrEqual(1.00001);
  }
  expect(shiftedCount).toBeGreaterThan(0);
  expect(causticCount).toBeGreaterThan(0);
});
