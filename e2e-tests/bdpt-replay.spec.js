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
  let sample = BdptReplaySample(vec4u(2u, 1u, 0u, id.x + 37u), BdptReplayCoordinates(vec2f(0.0), 0u, 0u), vec4f(0.0));
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
  let causticSample = BdptReplaySample(vec4u(4u, 1u, 0u, id.x + 37u), BdptReplayCoordinates(vec2f(0.0), 0u, 0u), vec4f(0.0));
  let caustic = bdptReplay(causticSample, camera, vec2u(0u), 64u, &workspace);
  let causticPixel = caustic.candidate.pixel;
  let causticShift = bdptShiftReplay(causticSample, camera, causticPixel, vec2u((causticPixel.x + 1u) % uni.resolution.x, causticPixel.y), 64u, &workspace);
  let causticReplay = bdptShiftReplay(causticSample, camera, causticPixel, causticPixel, 64u, &workspace);
  let cameraSample = BdptReplaySample(vec4u(1u, 2u, id.x + 19u, id.x + 37u), BdptReplayCoordinates(vec2f(0.0), 0u, 0u), vec4f(0.0));
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
    expect([0, 1]).toContain(row[12]);
    expect(row[13]).toBe(1);
    if (row[12] > 0) expect(row[14]).toBe(1);
    expect(row[15]).toBeGreaterThanOrEqual(0);
    expect(row[15]).toBeLessThanOrEqual(1.00001);
  }
  expect(shiftedCount).toBeGreaterThan(0);
  expect(causticCount).toBeGreaterThan(0);
});

const motionEntry = `
struct MotionResult { normal: vec4f, caustic: vec4f, restored: vec4f }
@group(1) @binding(0) var<storage, read_write> results: array<MotionResult>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var workspace: BdptWorkspace;
  let sample = BdptReplaySample(vec4u(2u, 1u, 0u, id.x + 37u), BdptReplayCoordinates(vec2f(0.0), 0u, 0u), vec4f(0.0));
  let source = bdptReplay(sample, uni.cam, vec2u(0u), 64u, &workspace);
  var destination = uni.cam;
  destination.pos.x += 0.2;
  let shifted = bdptShiftBetweenCameras(sample, uni.cam, destination, source.candidate.pixel, source.candidate.pixel, 64u, &workspace);
  let reverse = bdptShiftBetweenCameras(shifted.sample, destination, uni.cam, source.candidate.pixel, source.candidate.pixel, 64u, &workspace);
  var sourceCamera = uni.cam;
  sourceCamera.pos.x = 1.3;
  sourceCamera.pos.w = 1.2;
  destination = sourceCamera;
  destination.pos.x += 0.7;
  let causticSample = BdptReplaySample(vec4u(4u, 1u, 0u, id.x + 37u), BdptReplayCoordinates(vec2f(0.0), 0u, 0u), vec4f(0.0));
  let original = bdptShiftCaustic(causticSample, sourceCamera, 64u, &workspace);
  let moved = bdptShiftCaustic(causticSample, destination, 64u, &workspace);
  let restored = bdptShiftCaustic(moved.sample, sourceCamera, 64u, &workspace);
  results[id.x] = MotionResult(
    vec4f(shifted.jacobian, reverse.jacobian, length(reverse.evaluation.endpoint.pos - source.endpoint.pos),
      length(shifted.evaluation.endpoint.pos - source.endpoint.pos)),
    vec4f(original.jacobian, moved.jacobian,
      select(0.0, 1.0, any(original.evaluation.candidate.pixel != moved.evaluation.candidate.pixel)),
      length(original.evaluation.endpoint.pos - moved.evaluation.endpoint.pos)),
    vec4f(restored.jacobian, length(original.evaluation.candidate.estimator - restored.evaluation.candidate.estimator),
      select(0.0, 1.0, all(restored.sample.techniqueSeeds == causticSample.techniqueSeeds)),
      select(0.0, 1.0, all(restored.evaluation.candidate.pixel == original.evaluation.candidate.pixel))));
}
`;

test("BDPT camera-motion shifts are invertible and reproject caustics to new pixels", async ({
  page,
}) => {
  await page.goto("/");
  const result = await runBdptProbe(page, shader + motionEntry, 12, true);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  let normalCount = 0;
  let movedCaustics = 0;
  for (let index = 0; index < 1024; index++) {
    const row = result.data.slice(index * 12, (index + 1) * 12);
    expect(row.every(Number.isFinite)).toBe(true);
    if (row[0] > 0 && row[1] > 0) {
      normalCount++;
      expect(row[0] * row[1]).toBeCloseTo(1, 4);
      expect(row[2]).toBeLessThan(0.0001);
      expect(row[3]).toBeGreaterThan(0.01);
    }
    if (row[4] > 0 && row[5] > 0) {
      movedCaustics += row[6];
      expect(row[7]).toBeLessThan(0.0001);
      expect(row.slice(8, 12)).toEqual([1, 0, 1, 1]);
    }
  }
  expect(normalCount).toBeGreaterThan(0);
  expect(movedCaustics).toBeGreaterThan(0);
});

const hybridEntry = `
struct HybridResult { valid: vec4f, suffix: vec4f, roundtrip: vec4f }
@group(1) @binding(0) var<storage, read_write> results: array<HybridResult>;
fn suffixChecksum(path: ptr<function, BdptSubpath>, start: u32) -> vec3f {
  var value = vec3f(0.0);
  for (var i = start; i < (*path).count; i++) { value += (*path).vertices[i].surface.pos * f32(i + 1u); }
  return value;
}
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var workspace: BdptWorkspace;
  let pixel = vec2u(1u, 1u);
  let sample = BdptReplaySample(vec4u(1u, 4u, id.x + 19u, id.x + 37u), BdptReplayCoordinates(vec2f(0.0), 0u, 0u), vec4f(0.0));
  let source = bdptReplay(sample, uni.cam, pixel, 64u, &workspace);
  let connection = bdptCameraReconnection(&workspace.cameraPath);
  let checksum = suffixChecksum(&workspace.cameraPath, max(1u, connection) - 1u);
  var b = uni.cam; b.pos.x += 0.02;
  var c = uni.cam; c.pos.x -= 0.02;
  let ab = bdptShiftBetweenCameras(sample, uni.cam, b, pixel, pixel, 64u, &workspace);
  let shiftedChecksum = suffixChecksum(&workspace.cameraPath, max(1u, connection) - 1u);
  let ba = bdptShiftBetweenCameras(ab.sample, b, uni.cam, pixel, pixel, 64u, &workspace);
  let bc = bdptShiftBetweenCameras(ab.sample, b, c, pixel, pixel, 64u, &workspace);
  let ca = bdptShiftBetweenCameras(bc.sample, c, uni.cam, pixel, pixel, 64u, &workspace);
  var wrongSide = ab.sample;
  let code = wrongSide.coordinates.cameraSurface;
  wrongSide.coordinates.cameraSurface = code ^ 1u;
  let rejected = bdptReplay(wrongSide, b, pixel, 64u, &workspace);
  results[id.x] = HybridResult(
    vec4f(f32(connection), ab.jacobian, ba.jacobian, bc.jacobian * ca.jacobian),
    vec4f(length(checksum - shiftedChecksum), ab.sample.cameraReconnection.w,
      select(0.0, 1.0, all(ab.sample.cameraReconnection == bc.sample.cameraReconnection)), maxComponent(rejected.candidate.estimator)),
    vec4f(length(source.candidate.estimator - ca.evaluation.candidate.estimator),
      abs(source.candidate.misWeight - ca.evaluation.candidate.misWeight), ca.jacobian, maxComponent(source.candidate.estimator)));
}
`;

test("BDPT hybrid shifts preserve the suffix through repeated camera changes", async ({
  page,
}) => {
  await page.goto("/");
  const result = await runBdptProbe(page, shader + hybridEntry, 12, true);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  let valid = 0;
  for (let index = 0; index < 1024; index++) {
    const row = result.data.slice(index * 12, (index + 1) * 12);
    expect(row.every(Number.isFinite)).toBe(true);
    if (row[0] > 0 && row[1] > 0 && row[2] > 0 && row[3] > 0) {
      valid++;
      expect(row[1] * row[2]).toBeCloseTo(1, 4);
      expect(row[1] * row[3]).toBeCloseTo(1, 4);
      expect(row[4]).toBeLessThan(0.0001);
      expect(row[5]).toBe(row[0]);
      expect(row[6]).toBe(1);
      expect(row[7]).toBe(0);
      expect(row[8]).toBeLessThan(0.0001);
      expect(row[9]).toBeLessThan(0.0001);
    }
  }
  expect(valid).toBeGreaterThan(0);
});
