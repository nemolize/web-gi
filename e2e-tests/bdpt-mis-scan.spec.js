import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { runBdptProbe } from "./bdpt-fixture";

const prefix = [
  "common",
  "scene",
  "bdpt-resampling",
  "bdpt-transport",
  "bdpt-subpath",
  "bdpt-camera",
  "bdpt-mis",
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
  forward: array<f32, 32>,
  reverse: array<f32, 32>,
  delta: array<f32, 32>,
  weights: array<f32, 32>,
  parameters: vec4f,
}
@group(1) @binding(0) var<storage, read_write> results: array<Result>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var path: BdptMisPath;
  path.count = 2u + id.x % 31u;
  path.emitterPdfArea = select(pow(10.0, f32(i32(id.x % 25u) - 12)), 0.0, id.x % 17u == 0u);
  path.vertices[0] = BdptMisVertex(uni.cam.pos.xyz, uni.cam.forward.xyz, false);
  for (var i = 1u; i < path.count; i++) {
    let position = vec3f(f32(i % 2u), 0.1 * f32(i), 0.0);
    let normal = normalize(vec3f(select(1.0, -1.0, i % 2u == 1u), select(0.2, -0.2, id.x % 3u == 0u), 0.0));
    path.vertices[i] = BdptMisVertex(position, normal, (i + id.x) % 7u == 0u);
  }
  if (id.x % 13u == 0u) { path.vertices[1].position = path.vertices[0].position; }
  let samples = select(65536u, 0u, id.x % 19u == 0u);
  for (var i = 0u; i < path.count; i++) {
    results[id.x].delta[i] = select(0.0, 1.0, path.vertices[i].delta);
    results[id.x].weights[i] = bdptTechniqueWeight(uni.cam, &path, i + 1u, samples);
    if (i > 0u) { results[id.x].forward[i] = bdptMisEdgeFactor(uni.cam, &path, i - 1u, i); }
    if (i > 0u && i + 1u < path.count) { results[id.x].reverse[i] = bdptMisEdgeFactor(uni.cam, &path, i + 1u, i); }
  }
  results[id.x].parameters = vec4f(f32(path.count), path.emitterPdfArea, f32(samples), 0.0);
}`;

test("streaming MIS agrees with direct CPU products across long paths and zero densities", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const result = await runBdptProbe(page, prefix + entry, 132);
  test.skip(result === null, "WebGPU is unavailable.");
  expect(result.errors).toEqual([]);
  let maximumError = 0;
  let supportedPaths = 0;
  for (let id = 0; id < 1024; id++) {
    const row = result.data.slice(id * 132, (id + 1) * 132);
    const [count, emitter, lightSamples] = row.slice(128);
    const scores = [];
    for (let t = 1; t <= count; t++) {
      const samples = t === 1 ? lightSamples : 1;
      const factors = row.slice(1, t);
      if (t < count)
        factors.push(emitter, ...row.slice(32 + t, 32 + count - 1));
      const supported =
        samples > 0 &&
        factors.every((value) => value > 0) &&
        (t === count || (row[64 + t - 1] === 0 && row[64 + t] === 0));
      scores.push(
        supported
          ? 2 *
              (Math.log(samples) +
                factors.reduce(
                  (sum, value) => sum + Math.log(Math.max(value, 1e-38)),
                  0,
                ))
          : -Infinity,
      );
    }
    const maximum = Math.max(...scores);
    const terms = scores.map((score) =>
      Number.isFinite(score) ? Math.exp(score - maximum) : 0,
    );
    const sum = terms.reduce((a, b) => a + b, 0);
    if (sum > 0) supportedPaths++;
    for (let index = 0; index < count; index++) {
      const actual = row[96 + index];
      expect(Number.isFinite(actual)).toBe(true);
      const expected = sum > 0 ? terms[index] / sum : 0;
      maximumError = Math.max(maximumError, Math.abs(actual - expected));
      expect(actual).toBeGreaterThanOrEqual(0);
      expect(actual).toBeLessThanOrEqual(1.0001);
    }
  }
  expect(supportedPaths).toBeGreaterThan(100);
  expect(maximumError).toBeLessThan(0.0002);
  console.log({ supportedPaths, maximumError });
});
