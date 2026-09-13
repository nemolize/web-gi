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
    let independent = bdptShiftReplay(sample, uni.cam, pixel, destination, 1024u, &workspace);
    let cached = bdptApplyShift(prepared, uni.cam, uni.cam, pixel, destination, 1024u, &workspace);
    error = max(error, abs(independent.jacobian - cached.jacobian));
    error = max(error, length(independent.evaluation.candidate.estimator - cached.evaluation.candidate.estimator));
    error = max(error, abs(independent.evaluation.candidate.misWeight - cached.evaluation.candidate.misWeight));
    error = max(error, length(independent.sample.cameraReconnection - cached.sample.cameraReconnection));
    error = max(error, length(independent.sample.coordinates.filmOffset - cached.sample.coordinates.filmOffset));
    if (any(independent.sample.techniqueSeeds != cached.sample.techniqueSeeds)
      || any(independent.evaluation.candidate.pixel != cached.evaluation.candidate.pixel)
      || independent.sample.coordinates.overrideFilm != cached.sample.coordinates.overrideFilm
      || independent.sample.coordinates.cameraSurface != cached.sample.coordinates.cameraSurface) { error = 1e10; }
    valid += select(0.0, 1.0, cached.jacobian > 0.0);
  }
  results[id.x] = vec4f(error, valid, f32(sample.techniqueSeeds.y), prepared.evaluation.candidate.misWeight);
}`;

for (const reconnect of [false, true]) {
  test(`cached source survives workspace reuse across eight shifts, reconnect=${reconnect}`, async ({
    page,
  }) => {
    await page.goto("/?diagnostics=bdpt-execution");
    const body = reconnect
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
