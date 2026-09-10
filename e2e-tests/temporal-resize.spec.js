import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const shader = [
  readFileSync(
    new URL("../src/gi/shaders/common.wgsl", import.meta.url),
    "utf8",
  ),
  "@group(0) @binding(0) var<uniform> uni: Uniforms;",
  readFileSync(
    new URL("../src/gi/shaders/denoise-temporal.wgsl", import.meta.url),
    "utf8",
  ),
].join("\n");

test("resolution changes interpolate filtered history and reject other surfaces", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (code) => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    try {
      device.pushErrorScope("validation");
      const uniforms = new ArrayBuffer(224);
      const floats = new Float32Array(uniforms);
      const integers = new Uint32Array(uniforms);
      for (const offset of [0, 16]) {
        floats.set([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0], offset);
      }
      integers.set([4, 4, 0, 0], 32);
      integers[41] = 512;
      integers.set([64, 2, 2], 49);
      const uniform = device.createBuffer({
        size: 224,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(uniform, 0, uniforms);
      const texture = (pixel) => {
        const t = device.createTexture({
          size: [4, 4],
          format: "rgba32float",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const data = new Float32Array(64);
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) data.set(pixel(x, y), (y * 4 + x) * 4);
        }
        device.queue.writeTexture(
          { texture: t },
          data,
          { bytesPerRow: 64 },
          [4, 4],
        );
        return t;
      };
      const inputs = [
        texture(() => [12, 12, 12, 1]),
        texture(() => [1, 0, 0, 0]),
        texture(() => [0, 0, 1, 0]),
        texture(() => [1, 0, 0, 0]),
        texture(() => [0, 0, 1, 0]),
        texture(() => [99, 99, 99, 64]),
      ];
      const output = device.createTexture({
        size: [4, 4],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const filtered = texture((x, y) => {
        const color = x < 2 && y < 2 ? 4 + x * 4 + y * 8 : 999;
        return [color, color, color, 64];
      });
      const group0 = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "uniform" },
          },
        ],
      });
      const group1 = device.createBindGroupLayout({
        entries: Array.from({ length: 8 }, (_, binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          ...(binding === 6
            ? {
                storageTexture: { access: "write-only", format: "rgba32float" },
              }
            : { texture: { sampleType: "unfilterable-float" } }),
        })),
      });
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [group0, group1],
        }),
        compute: {
          module: device.createShaderModule({ code }),
          entryPoint: "main",
        },
      });
      const bind0 = device.createBindGroup({
        layout: group0,
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      });
      const bind1 = device.createBindGroup({
        layout: group1,
        entries: [...inputs, output, filtered].map((t, binding) => ({
          binding,
          resource: t.createView(),
        })),
      });
      const staging = device.createBuffer({
        size: 1024,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const render = async () => {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind0);
        pass.setBindGroup(1, bind1);
        pass.dispatchWorkgroups(1, 1);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: output },
          { buffer: staging, bytesPerRow: 256 },
          [4, 4],
        );
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(staging.getMappedRange()).slice();
        staging.unmap();
        return Array.from(data.slice(68, 72));
      };
      const transferred = await render();
      const reversedNormals = new Float32Array(64);
      for (let i = 0; i < 16; i++) reversedNormals[i * 4 + 2] = -1;
      device.queue.writeTexture(
        { texture: inputs[4] },
        reversedNormals,
        { bytesPerRow: 64 },
        [4, 4],
      );
      const rejected = await render();
      const error = await device.popErrorScope();
      return { transferred, rejected, error: error?.message ?? null };
    } finally {
      device.destroy();
    }
  }, shader);
  test.skip(result === null, "requires a WebGPU adapter");
  expect(result.error).toBeNull();
  for (const value of result.transferred.slice(0, 3))
    expect(value).toBeCloseTo((7 * 16 + 12) / 17, 4);
  expect(result.transferred[3]).toBe(17);
  expect(result.rejected).toEqual([12, 12, 12, 1]);
});
