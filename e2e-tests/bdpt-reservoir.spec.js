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
  "bdpt-reservoir",
]
  .map((name) =>
    readFileSync(
      new URL(`../src/gi/shaders/${name}.wgsl`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");

const entry = `
struct Result {
  radianceConfidence: vec4f,
  seeds: vec4f,
  offset: vec4f,
}
@group(1) @binding(0) var<storage, read_write> results: array<Result>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let mode = id.x % 4u;
  let random = (f32(id.x / 4u) + 0.5) / 256.0;
  var current = bdptEmptyReplayReservoir(1.0);
  var previous = bdptEmptyReplayReservoir(20.0);
  let a = BdptReplaySample(vec4u(2u, 1u, 123u, 456u), BdptReplayCoordinates(vec2f(0.2, 0.3), 1u, 0u), vec4f(0.0));
  let b = BdptReplaySample(vec4u(3u, 1u, 789u, 987u), BdptReplayCoordinates(vec2f(0.7, 0.8), 1u, 0u), vec4f(0.0));
  let candidateA = BdptCandidate(vec3f(2.0), 0.5, vec2u(0u));
  let candidateB = BdptCandidate(vec3f(6.0), 0.5, vec2u(0u));
  if (mode != 3u) {
    bdptUpdateReplayReservoir(&current, a, candidateA, 1.0, 1.0, 1.0, 0.5);
  }
  if (mode == 0u || mode == 2u) {
    bdptUpdateReplayReservoir(&previous, b, candidateB, 1.0, 1.0, 1.0, 0.5);
  }
  bdptFinalizeReservoir(&current.path);
  bdptFinalizeReservoir(&previous.path);
  let limit = select(4.0, 0.0, mode == 2u);
  let result = bdptTemporalReservoir(current, previous, limit, random);
  results[id.x] = Result(vec4f(bdptReservoirRadiance(result.path), result.path.confidence),
    vec4f(result.path.sample.techniqueSeeds), vec4f(result.coordinates.filmOffset, f32(result.coordinates.overrideFilm), f32(result.coordinates.cameraSurface)));
}
`;

test("BDPT temporal reservoirs retain selected replay coordinates and count empty history", async ({
  page,
}) => {
  await page.goto("/");
  const result = await runBdptProbe(page, shader + entry, 12);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  let currentSelections = 0;
  let historySelections = 0;
  for (let index = 0; index < 1024; index++) {
    const values = result.data.slice(index * 12, (index + 1) * 12);
    expect(values.every(Number.isFinite)).toBe(true);
    const mode = index % 4;
    const expectedRadiance = [2.6, 0.2, 1, 0][mode];
    for (const channel of values.slice(0, 3)) {
      expect(channel).toBeCloseTo(expectedRadiance, 5);
    }
    expect(values[3]).toBe(mode === 2 ? 1 : 5);
    const selectedHistory = values[4] === 3;
    const expectedSeeds =
      mode === 3
        ? [0, 0, 0, 0]
        : selectedHistory
          ? [3, 1, 789, 987]
          : [2, 1, 123, 456];
    expect(values.slice(4, 8)).toEqual(expectedSeeds);
    const expectedOffset =
      mode === 3
        ? [0, 0, 0, 0]
        : selectedHistory
          ? [0.7, 0.8, 1, 0]
          : [0.2, 0.3, 1, 0];
    expectedOffset.forEach((value, channel) =>
      expect(values[8 + channel]).toBeCloseTo(value, 6),
    );
    if (mode === 0) {
      if (selectedHistory) historySelections++;
      else currentSelections++;
    }
  }
  expect(currentSelections).toBeGreaterThan(0);
  expect(historySelections).toBeGreaterThan(0);
});
