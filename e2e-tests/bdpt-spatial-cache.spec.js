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
fn shiftDifference(left: BdptShift, right: BdptShift) -> f32 {
  var error = 0.0;
  error = max(error, abs(left.jacobian - right.jacobian));
  error = max(error, length(left.evaluation.candidate.estimator - right.evaluation.candidate.estimator));
  error = max(error, abs(left.evaluation.candidate.misWeight - right.evaluation.candidate.misWeight));
  error = max(error, length(left.sample.cameraReconnection - right.sample.cameraReconnection));
  error = max(error, length(left.sample.coordinates.filmOffset - right.sample.coordinates.filmOffset));
  if (any(left.sample.techniqueSeeds != right.sample.techniqueSeeds)
    || any(left.evaluation.candidate.pixel != right.evaluation.candidate.pixel)
    || left.sample.coordinates.overrideFilm != right.sample.coordinates.overrideFilm
    || left.sample.coordinates.cameraSurface != right.sample.coordinates.cameraSurface) { error = 1e10; }
  return error;
}

@group(1) @binding(0) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var workspace: BdptWorkspace;
  let sample = BdptReplaySample(vec4u(select(2u, 1u, id.x % 2u == 1u), select(1u, 2u, id.x % 2u == 1u), id.x + 19u, id.x + 37u), BdptReplayCoordinates(vec2f(0.0), 0u, 0u), vec4f(0.0));
  let initial = bdptReplay(sample, uni.cam, vec2u(0u), 1024u, &workspace);
  let pixel = initial.candidate.pixel;
  let prepared = bdptPrepareShift(sample, uni.cam, pixel, 1024u, &workspace);
  var error = 0.0;
  var valid = 0.0;
  for (var neighbor = 0u; neighbor < 8u; neighbor++) {
    let destination = vec2u((pixel.x + neighbor) % 32u, pixel.y);
    var destinationCamera = uni.cam;
    let independent = bdptShiftBetweenCameras(sample, uni.cam, destinationCamera, pixel, destination, 1024u, &workspace);
    let cached = bdptApplyShift(prepared, uni.cam, destinationCamera, pixel, destination, 1024u, &workspace);
    error = max(error, shiftDifference(independent, cached));
    if (independent.jacobian > 0.0) {
      let returnedSource = bdptPrepareShift(independent.sample, destinationCamera, destination, 1024u, &workspace);
      let returnedCached = bdptApplyShift(returnedSource, destinationCamera, uni.cam, destination, pixel, 1024u, &workspace);
      let returnedIndependent = bdptShiftBetweenCameras(independent.sample, destinationCamera, uni.cam, destination, pixel, 1024u, &workspace);
      error = max(error, shiftDifference(returnedIndependent, returnedCached));
    }
    valid += select(0.0, 1.0, cached.jacobian > 0.0);
  }
  results[id.x] = vec4f(error, valid, f32(sample.techniqueSeeds.y), prepared.evaluation.candidate.misWeight);
}`;

for (const [reconnect, moving] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
]) {
  test(`cached source survives workspace reuse across eight shifts, reconnect=${reconnect}, moving=${moving}`, async ({
    page,
  }) => {
    await page.goto("/?diagnostics=bdpt-execution");
    let body = reconnect
      ? entry
          .replace(
            "select(2u, 1u, id.x % 2u == 1u), select(1u, 2u, id.x % 2u == 1u)",
            "1u, 4u",
          )
          .replace("uni.cam, vec2u(0u), 1024u", "uni.cam, vec2u(1u), 1024u")
          .replace(
            "prepared.evaluation.candidate.misWeight);",
            "f32(prepared.connection));",
          )
      : entry;
    if (moving)
      body = body.replace(
        "var destinationCamera = uni.cam;",
        "var destinationCamera = uni.cam; destinationCamera.pos.x += 0.02 * f32(neighbor + 1u);",
      );
    const result = await runBdptProbe(page, shader + body, 4, reconnect);
    test.skip(!result, "WebGPU unavailable");
    expect(result.errors).toEqual([]);
    const valid = [0, 0];
    let reconnections = 0;
    for (let offset = 0; offset < result.data.length; offset += 4) {
      expect(result.data[offset]).toBeLessThan(1e-5);
      valid[result.data[offset + 2] === 1 ? 0 : 1] += result.data[offset + 1];
      if (result.data[offset + 3] > 0 && result.data[offset + 1] > 0)
        reconnections++;
    }
    if (reconnect) expect(reconnections).toBeGreaterThan(0);
    else expect(valid[0]).toBeGreaterThan(0);
    expect(valid[1]).toBeGreaterThan(0);
  });
}
