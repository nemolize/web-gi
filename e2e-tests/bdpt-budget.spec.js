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
