import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const shader = ["common", "scene", "bdpt-transport", "bdpt-subpath"]
  .map((name) =>
    readFileSync(
      new URL(`../src/gi/shaders/${name}.wgsl`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");

const entry = `
struct Probe {
  lengths: vec4f,
  checks: vec4f,
  reflection: vec4f,
  transmission: vec4f,
  importance: vec4f,
  connections: vec4f,
  material: vec4f,
  limits: vec4f,
}
@group(1) @binding(0) var<storage, read_write> probes: array<Probe>;
fn samePath(a: BdptSubpath, b: BdptSubpath) -> bool {
  if (a.count != b.count || a.emitterPdfArea != b.emitterPdfArea) { return false; }
  for (var i = 0u; i < a.count; i++) {
    if (any(a.vertices[i].surface.pos != b.vertices[i].surface.pos)
      || any(a.vertices[i].throughput != b.vertices[i].throughput)
      || a.vertices[i].sampledForwardPdf != b.vertices[i].sampledForwardPdf) { return false; }
  }
  return true;
}
fn deltaCount(path: BdptSubpath) -> f32 {
  var count = 0.0;
  for (var i = 0u; i < path.count; i++) {
    count += select(0.0, 1.0, path.vertices[i].surface.materialIndex > 0u);
  }
  return count;
}
fn validPath(path: BdptSubpath) -> bool {
  for (var i = 0u; i < path.count; i++) {
    let beta = path.vertices[i].throughput;
    if (!all(beta >= vec3f(0.0)) || !all(beta < vec3f(1e10))) { return false; }
  }
  return true;
}
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel = vec2u(id.x % 32u, id.x / 32u);
  let ndc = (vec2f(pixel) + 0.5) / 16.0 - 1.0;
  let camera = bdptCameraSubpath(uni.cam, ndc, id.x + 19u, 8u);
  let light = bdptLightSubpath(id.x + 37u, 8u);
  let replayCamera = bdptCameraSubpath(uni.cam, ndc, id.x + 19u, 8u);
  let replayLight = bdptLightSubpath(id.x + 37u, 8u);
  var hit: HitInfo;
  hit.hit = true;
  hit.normal = vec3f(0.0, 1.0, 0.0);
  hit.albedo = vec3f(0.8, 0.9, 1.0);
  hit.materialIndex = 1u;
  hit.frontFace = true;
  let reflected = bdptSampleScatter(hit, vec3f(0.0, -1.0, 0.0), true, vec3f(0.0));
  let incoming = vec3f(0.6, -0.8, 0.0);
  let transmitted = bdptSampleScatter(hit, incoming, true, vec3f(0.5));
  let importance = bdptSampleScatter(hit, incoming, false, vec3f(0.5));
  hit.frontFace = false;
  let tir = bdptSampleScatter(hit, vec3f(0.8, -0.6, 0.0), true, vec3f(0.5));
  let exiting = bdptSampleScatter(hit, vec3f(sqrt(0.4375), -0.75, 0.0), true, vec3f(0.75));
  let emptyCamera = bdptCameraSubpath(uni.cam, ndc, id.x, 0u);
  let emptyLight = bdptLightSubpath(id.x, 0u);
  let emitterOnly = bdptLightSubpath(id.x, 1u);
  var c: BdptVertex;
  c.surface.hit = true;
  c.surface.pos = vec3f(2.0, 0.0, 0.0);
  c.surface.normal = vec3f(0.0, 1.0, 0.0);
  c.surface.albedo = vec3f(0.5);
  c.throughput = vec3f(1.0);
  var l: BdptVertex;
  l.surface.hit = true;
  l.surface.pos = vec3f(2.0, 2.0, 0.0);
  l.surface.normal = vec3f(0.0, -1.0, 0.0);
  l.surface.albedo = vec3f(0.25);
  l.throughput = vec3f(4.0);
  let direct = bdptConnectSurfaces(c, l, true).x;
  let joined = bdptConnectSurfaces(c, l, false).x;
  c.surface.pos.x = 0.0;
  l.surface.pos.x = 0.0;
  let occluded = bdptConnectSurfaces(c, l, true).x;
  c.surface.materialIndex = 1u;
  let deltaConnection = bdptConnectSurfaces(c, l, true).x;
  probes[id.x] = Probe(
    vec4f(f32(camera.count), f32(light.count), deltaCount(camera), deltaCount(light)),
    vec4f(select(0.0, 1.0, samePath(camera, replayCamera) && samePath(light, replayLight)),
      select(0.0, 1.0, validPath(camera) && validPath(light)), tir.forwardPdf, tir.direction.y),
    vec4f(reflected.direction, reflected.forwardPdf),
    vec4f(transmitted.direction, transmitted.throughput.x),
    vec4f(importance.throughput, importance.forwardPdf),
    vec4f(direct, joined, occluded, deltaConnection),
    vec4f(exiting.throughput.x, exiting.forwardPdf, fresnelReflectance(0.75, 1.5),
      bdptPdfToArea(0.25, vec3f(0.0, 2.0, 0.0), vec3f(0.0), vec3f(0.0, 1.0, 0.0))),
    vec4f(f32(emptyCamera.count), f32(emptyLight.count), f32(emitterOnly.count), emitterOnly.emitterPdfArea)
  );
}
`;

test("BDPT generates reproducible camera and light subpaths through glass", async ({
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
      const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
        const resource = device.createBuffer({
          size: data.byteLength,
          usage: usage | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(resource, 0, data);
        return resource;
      };
      const uniforms = new ArrayBuffer(224);
      new Float32Array(uniforms).set([
        0, 1.9, 0, 0.5, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0,
      ]);
      const u = new Uint32Array(uniforms);
      u.set([32, 32, 0, 0, 2, 1], 32);
      u[45] = 1;
      u[46] = 1;
      u[47] = 1;
      const uniform = buffer(uniforms, GPUBufferUsage.UNIFORM);
      const quads = buffer(
        new Float32Array([
          -10,
          0,
          10,
          400,
          20,
          0,
          0,
          1 / 400,
          0,
          0,
          -20,
          1 / 400,
          0,
          1,
          0,
          0,
          0.5,
          0.5,
          0.5,
          0,
          0,
          0,
          0,
          0,
          -0.5,
          2,
          -0.5,
          1,
          1,
          0,
          0,
          1,
          0,
          0,
          1,
          1,
          0,
          -1,
          0,
          0,
          0,
          0,
          0,
          0,
          4,
          4,
          4,
          0,
        ]),
      );
      const lightData = new ArrayBuffer(16);
      new Uint32Array(lightData)[0] = 1;
      new Float32Array(lightData).set([1, 1], 1);
      const lights = buffer(lightData);
      const clusters = buffer(
        new Float32Array([-10, -0.001, -10, 0, 10, 2.001, 10, 2]),
      );
      const glass = buffer(
        new Float32Array([0, 1, 0, 0, 0, 0, 0, 0.4, 0.8, 0.9, 1, 1.5]),
      );
      const module = device.createShaderModule({ code });
      const diagnostics = await module.getCompilationInfo();
      errors.push(
        ...diagnostics.messages
          .filter((m) => m.type === "error")
          .map((m) => m.message),
      );
      if (errors.length) throw new Error(errors.join("\n"));
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      const size = 1024 * 128;
      const output = device.createBuffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const staging = device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const scene = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [uniform, quads, lights, clusters, glass].map(
          (resource, binding) => ({ binding, resource: { buffer: resource } }),
        ),
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: output } }],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, scene);
      pass.setBindGroup(1, group);
      pass.dispatchWorkgroups(32);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = Array.from(new Float32Array(staging.getMappedRange()));
      staging.unmap();
      const validation = await device.popErrorScope();
      if (validation) errors.push(validation.message);
      return { errors, data };
    } finally {
      device.destroy();
    }
  }, shader + entry);
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  let cameraGlass = 0;
  let lightGlass = 0;
  for (let i = 0; i < 1024; i++) {
    const row = result.data.slice(i * 32, (i + 1) * 32);
    expect(row.every(Number.isFinite)).toBe(true);
    expect(row[0]).toBeGreaterThanOrEqual(1);
    expect(row[0]).toBeLessThanOrEqual(8);
    expect(row[1]).toBeGreaterThanOrEqual(1);
    expect(row[1]).toBeLessThanOrEqual(8);
    cameraGlass += row[2];
    lightGlass += row[3];
    expect(row.slice(4, 7)).toEqual([1, 1, 1]);
    expect(row[7]).toBeCloseTo(0.6, 5);
    expect(row.slice(8, 11)).toEqual([0, 1, 0]);
    expect(row[11]).toBeCloseTo(0.04, 5);
    expect(row[12]).toBeCloseTo(0.4, 5);
    expect(row[13]).toBeCloseTo(-Math.sqrt(0.84), 5);
    expect(row[14]).toBe(0);
    expect(row[15]).toBeCloseTo(1 / 1.5 ** 2, 5);
    [0.8, 0.9, 1].forEach((value, j) =>
      expect(row[16 + j]).toBeCloseTo(value, 5),
    );
    expect(row[19]).toBeGreaterThan(0);
    expect(row[19]).toBeLessThan(1);
    expect(row[20]).toBeCloseTo(0.5 / Math.PI, 5);
    expect(row[21]).toBeCloseTo(0.125 / Math.PI ** 2, 5);
    expect(row.slice(22, 24)).toEqual([0, 0]);
    [1.8, 0.5, 0.5, 0.0625].forEach((value, j) =>
      expect(row[24 + j]).toBeCloseTo(value, 5),
    );
    expect(row.slice(28, 32)).toEqual([0, 0, 1, 1]);
  }
  expect(cameraGlass).toBeGreaterThan(0);
  expect(lightGlass).toBeGreaterThan(0);
});
