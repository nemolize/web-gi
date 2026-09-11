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
struct Result {
  weights: vec4f,
  deltaWeights: vec4f,
  projection: vec4f,
  rejected: vec4f,
  cameraOnly: vec4f,
  nee: vec4f,
  connection: vec4f,
  lightTrace: vec4f,
}
@group(1) @binding(0) var<storage, read_write> results: array<Result>;
fn candidateValue(candidate: BdptCandidate) -> vec4f {
  return vec4f(candidate.estimator * candidate.misWeight, candidate.misWeight);
}
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var camera = uni.cam;
  camera.pos.y = 3.0;
  var path: BdptMisPath;
  path.count = 4u;
  path.emitterPdfArea = 1.0;
  path.vertices[0] = BdptMisVertex(camera.pos.xyz, camera.forward.xyz, false);
  path.vertices[1] = BdptMisVertex(vec3f(0.0), vec3f(0.0, 1.0, 0.0), false);
  path.vertices[2] = BdptMisVertex(vec3f(1.0, 1.0, 0.0), vec3f(-1.0, 0.0, 0.0), false);
  path.vertices[3] = BdptMisVertex(vec3f(0.0, 2.0, 0.0), vec3f(0.0, -1.0, 0.0), false);
  var weights: vec4f;
  var deltaWeights: vec4f;
  for (var t = 1u; t <= 4u; t++) {
    weights[t - 1u] = bdptTechniqueWeight(camera, &path, t, 64u);
  }
  path.vertices[2].delta = true;
  for (var t = 1u; t <= 4u; t++) {
    deltaWeights[t - 1u] = bdptTechniqueWeight(camera, &path, t, 64u);
  }
  let center = bdptProjectToCamera(camera, vec3f(0.0), vec3f(0.0, 1.0, 0.0));
  let outside = bdptProjectToCamera(camera, vec3f(100.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0));
  let behind = bdptProjectToCamera(camera, vec3f(0.0, 4.0, 0.0), vec3f(0.0, -1.0, 0.0));
  let backFace = bdptProjectToCamera(camera, vec3f(0.0), vec3f(0.0, -1.0, 0.0));
  let pixel = vec2u(id.x % 32u, id.x / 32u);
  let ndc = (vec2f(pixel) + 0.5) / 16.0 - 1.0;
  var workspace: BdptWorkspace;
  bdptBuildCameraSubpath(uni.cam, ndc, id.x + 19u, 6u, &workspace.cameraPath);
  bdptBuildLightSubpath(id.x + 37u, 6u, &workspace.lightPath);
  var t = 0u;
  for (var index = 0u; index < workspace.cameraPath.count; index++) {
    if (workspace.cameraPath.vertices[index].surface.materialIndex == 0u) { t = index + 2u; break; }
  }
  var s = 0u;
  for (var index = 1u; index < workspace.lightPath.count; index++) {
    if (workspace.lightPath.vertices[index].surface.materialIndex == 0u) { s = index + 1u; break; }
  }
  var emissionCamera = uni.cam;
  emissionCamera.forward.y = 1.0;
  let nee = bdptEvaluateCandidate(uni.cam, t, 1u, pixel, 64u, &workspace);
  let connected = bdptEvaluateCandidate(uni.cam, t, s, pixel, 64u, &workspace);
  let traced = bdptEvaluateCandidate(uni.cam, 1u, s, pixel, 64u, &workspace);
  bdptBuildCameraSubpath(emissionCamera, vec2f(0.0), id.x, 1u, &workspace.cameraPath);
  let emission = bdptEvaluateCandidate(emissionCamera, 2u, 0u, pixel, 64u, &workspace);
  results[id.x] = Result(weights, deltaWeights,
    vec4f(vec2f(center.pixel), center.pdfArea, select(0.0, 1.0, center.valid)),
    vec4f(select(0.0, 1.0, outside.valid), select(0.0, 1.0, behind.valid), select(0.0, 1.0, backFace.valid),
      select(0.0, 1.0, all(traced.pixel < uni.resolution))),
    candidateValue(emission), candidateValue(nee), candidateValue(connected), candidateValue(traced));
}
`;

test("BDPT evaluates all techniques with camera normalization and path-wide MIS", async ({
  page,
}) => {
  await page.goto("/");
  const result = await runBdptProbe(page, shader + entry, 32, true);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  const normalizeSquares = (scores) => {
    const sum = scores.reduce((total, value) => total + value ** 2, 0);
    return scores.map((value) => value ** 2 / sum);
  };
  const area = 1 / (4 * Math.PI);
  const cameraPdf = 1024 / 9;
  const expected = normalizeSquares([
    64 * area ** 2,
    cameraPdf * area,
    cameraPdf * area,
    cameraPdf * area ** 2,
  ]);
  const expectedDelta = normalizeSquares([64 * area, 0, 0, cameraPdf * area]);
  const positive = [0, 0, 0, 0];
  for (let i = 0; i < 1024; i++) {
    const row = result.data.slice(i * 32, (i + 1) * 32);
    expect(row.every(Number.isFinite)).toBe(true);
    expected.forEach((value, j) => expect(row[j]).toBeCloseTo(value, 5));
    expectedDelta.forEach((value, j) =>
      expect(row[4 + j]).toBeCloseTo(value, 5),
    );
    expect(row.slice(8, 10)).toEqual([16, 16]);
    expect(row[10]).toBeCloseTo(1024 / 9, 4);
    expect(row.slice(11, 16)).toEqual([1, 0, 0, 0, 1]);
    for (let technique = 0; technique < 4; technique++) {
      const offset = 16 + technique * 4;
      expect(row[offset]).toBeGreaterThanOrEqual(0);
      expect(row[offset + 3]).toBeGreaterThanOrEqual(0);
      expect(row[offset + 3]).toBeLessThanOrEqual(1.00001);
      if (row[offset] > 0) positive[technique]++;
    }
    expect(row[16]).toBeCloseTo((4 * 102400 ** 2) / (102400 ** 2 + 64 ** 2), 4);
  }
  positive.forEach((count) => expect(count).toBeGreaterThan(0));
});
