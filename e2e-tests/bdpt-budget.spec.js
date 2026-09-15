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
  var path: BdptMisPath;
  for (var index = 0u; index < BDPT_MAX_VERTICES; index++) { path.vertices[index].delta = true; }
  let mode = id.x % 6u;
  path.count = 6u;
  if (mode < 4u) {
    path.count = select(7u, 6u, mode == 0u);
    let first = select(1u, 2u, mode == 2u);
    let last = select(first + 3u, 5u, mode == 3u);
    for (var index = first; index <= last; index++) { path.vertices[index].delta = false; }
  } else {
    path.count = select(10u, 11u, mode == 5u);
  }
  results[id.x] = vec4f(select(0.0, 1.0, bdptPathWithinBudget(&path)), f32(bdptVertexLimit()), 0.0, 0.0);
}
`;

test("BDPT accepts direct light at the diffuse limit but rejects a subsequent delta tail", async ({
  page,
}) => {
  await page.goto("/");
  const result = await runBdptProbe(page, shader + entry, 4);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  const accepted = [1, 0, 1, 0, 1, 0];
  for (let index = 0; index < 1024; index++) {
    expect(result.data[index * 4]).toBe(accepted[index % 6]);
    expect(result.data[index * 4 + 1]).toBe(10);
  }
});

const unbounded = readFileSync(
  new URL("./bdpt-unbounded-subpath.wgsl", import.meta.url),
  "utf8",
);

const pruningEntry = `
@group(1) @binding(0) var<storage, read_write> results: array<vec4f>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2u(id.x % 32u, id.x / 32u);
  let ndc = (vec2f(pixel) + 0.5) / 16.0 - 1.0;
  var bounded: BdptWorkspace;
  var original: BdptWorkspace;
  bdptBuildCameraSubpath(uni.cam, ndc, id.x + 19u, BDPT_MAX_VERTICES - 1u, &bounded.cameraPath);
  bdptBuildLightSubpath(id.x + 37u, BDPT_MAX_VERTICES - 2u, &bounded.lightPath);
  bdptBuildCameraSubpathUnbounded(uni.cam, ndc, id.x + 19u, BDPT_MAX_VERTICES - 1u, &original.cameraPath);
  bdptBuildLightSubpathUnbounded(id.x + 37u, BDPT_MAX_VERTICES - 2u, &original.lightPath);
  var error = 0.0;
  var positive = 0.0;
  for (var t = 1u; t <= original.cameraPath.count + 1u; t++) {
    for (var s = 0u; s <= original.lightPath.count && s + t <= BDPT_MAX_VERTICES; s++) {
      let expected = bdptEvaluateCandidate(uni.cam, t, s, pixel, 1024u, &original);
      let actual = bdptEvaluateCandidate(uni.cam, t, s, pixel, 1024u, &bounded);
      let expectedRadiance = expected.estimator * expected.misWeight;
      let actualRadiance = actual.estimator * actual.misWeight;
      error = max(error, length(actualRadiance - expectedRadiance) / max(1.0, length(expectedRadiance)));
      error = max(error, abs(actual.misWeight - expected.misWeight));
      if (maxComponent(expectedRadiance) > 0.0) { positive += 1.0; }
    }
  }
  results[id.x] = vec4f(error, positive,
    f32(original.cameraPath.count - bounded.cameraPath.count),
    f32(original.lightPath.count - bounded.lightPath.count));
}
`;

for (const bounces of [1, 3, 6, 12]) {
  test(`subpath pruning preserves every candidate at ${bounces} bounces`, async ({
    page,
  }) => {
    await page.goto("/?diagnostics=core");
    const code = (shader + unbounded + pruningEntry).replaceAll(
      "uni.maxBounces",
      `${bounces}u`,
    );
    const result = await runBdptProbe(page, code, 4, true);
    test.skip(result === null, "WebGPU is unavailable in this browser.");
    expect(result.errors).toEqual([]);
    let positive = 0;
    let trimmed = 0;
    for (let offset = 0; offset < result.data.length; offset += 4) {
      expect(result.data.slice(offset, offset + 4).every(Number.isFinite)).toBe(
        true,
      );
      expect(result.data[offset]).toBeLessThan(1e-6);
      positive += result.data[offset + 1];
      trimmed += result.data[offset + 2] + result.data[offset + 3];
    }
    expect(positive).toBeGreaterThan(100);
    if (bounces === 1) expect(trimmed).toBeGreaterThan(0);
    console.log({ bounces, positive, trimmed });
  });
}
