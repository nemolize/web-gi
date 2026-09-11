import { expect, test } from "@playwright/test";

import { attachBdptComparisonImage } from "./bdpt-image";
import { isPreviewTarget } from "./target";

test("BDPT initial passes route glass caustics and clear light lists between frames", async ({
  page,
}) => {
  test.skip(
    isPreviewTarget,
    "The initial-pass harness imports development modules; application integration is pending.",
  );
  test.setTimeout(120_000);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener("uncapturederror", (event) =>
      errors.push(event.error.message),
    );
    const { createBdptInitialPasses } =
      await import("/src/gi/bdpt/initial-passes.ts");
    const { buildScene, packQuads, packLights, packClusters, packGlassShapes } =
      await import("/src/gi/scene.ts");
    const { cameraBasis, DEFAULT_CAMERA } = await import("/src/gi/camera.ts");
    let passes;
    try {
      device.pushErrorScope("validation");
      const width = 39;
      const height = 31;
      const pixels = width * height;
      const scene = buildScene("glassShapes");
      const camera = cameraBasis(DEFAULT_CAMERA, width / height);
      const data = new ArrayBuffer(224);
      const floats = new Float32Array(data);
      const integers = new Uint32Array(data);
      const vector = (v) => [v.x, v.y, v.z];
      floats.set([
        ...vector(camera.pos),
        camera.tanHalfFov,
        ...vector(camera.right),
        camera.aspect,
        ...vector(camera.up),
        0,
        ...vector(camera.forward),
        0,
      ]);
      integers.set(
        [width, height, 0, 0, scene.quads.length, scene.lights.length],
        32,
      );
      integers[40] = 3;
      integers.set(
        [
          scene.clusters.length,
          scene.occluderClusterCount,
          scene.glassShapes.length,
        ],
        45,
      );
      const upload = (label, data, usage = GPUBufferUsage.STORAGE) => {
        const buffer = device.createBuffer({
          label,
          size: data.byteLength,
          usage: usage | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      const uniform = upload("uniforms", data, GPUBufferUsage.UNIFORM);
      const quadData = packQuads(scene);
      const quads = upload("quads", quadData);
      const resources = [
        uniform,
        quads,
        upload("lights", packLights(scene)),
        upload("clusters", packClusters(scene)),
        upload("glass", packGlassShapes(scene)),
      ];
      const layout = device.createBindGroupLayout({
        entries: resources.map((_, binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: binding === 0 ? "uniform" : "read-only-storage" },
        })),
      });
      const group = device.createBindGroup({
        layout,
        entries: resources.map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
      passes = await createBdptInitialPasses(device, layout, width, height);
      const staging = device.createBuffer({
        size: pixels * 128,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const referenceLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: "unfilterable-float" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { access: "write-only", format: "rgba32float" },
          },
        ],
      });
      const referenceSources = await Promise.all(
        ["common", "scene", "reference"].map(
          async (name) =>
            (await import(`/src/gi/shaders/${name}.wgsl?raw`)).default,
        ),
      );
      const referencePipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [layout, referenceLayout],
        }),
        compute: {
          module: device.createShaderModule({
            code: referenceSources.join("\n"),
          }),
          entryPoint: "main",
        },
      });
      const referenceTextures = [0, 1].map(() =>
        device.createTexture({
          size: [width, height],
          format: "rgba32float",
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.COPY_SRC,
        }),
      );
      const referenceGroups = [0, 1].map((parity) =>
        device.createBindGroup({
          layout: referenceLayout,
          entries: [
            {
              binding: 0,
              resource: referenceTextures[1 - parity].createView(),
            },
            { binding: 1, resource: referenceTextures[parity].createView() },
          ],
        }),
      );
      const rowBytes = Math.ceil((width * 16) / 256) * 256;
      const referenceStaging = device.createBuffer({
        size: rowBytes * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const image = new Float32Array(pixels * 3);
      let causticSamples = 0;
      let emptySamples = 0;
      let finite = true;
      let confidenceValid = true;
      const read = async (frame) => {
        integers[34] = frame;
        integers[35] = frame;
        device.queue.writeBuffer(uniform, 0, data);
        const encoder = device.createCommandEncoder();
        passes.record(encoder, group);
        const referencePass = encoder.beginComputePass();
        referencePass.setPipeline(referencePipeline);
        referencePass.setBindGroup(0, group);
        referencePass.setBindGroup(1, referenceGroups[frame % 2]);
        referencePass.dispatchWorkgroups(
          Math.ceil(width / 8),
          Math.ceil(height / 8),
        );
        referencePass.end();
        encoder.copyBufferToBuffer(
          passes.reservoirs,
          0,
          staging,
          0,
          pixels * 128,
        );
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        return values;
      };
      for (let frame = 0; frame < 1024; frame++) {
        const values = await read(frame);
        for (let pixel = 0; pixel < pixels; pixel++) {
          for (let kind = 0; kind < 2; kind++) {
            const offset = pixel * 32 + kind * 16;
            const mis = values[offset + 7];
            const weight = values[offset + 9];
            const target = values[offset + 11];
            confidenceValid &&= values[offset + 10] === 1;
            if (target === 0) emptySamples++;
            if (kind === 1 && target > 0) causticSamples++;
            for (let channel = 0; channel < 3; channel++) {
              const radiance = values[offset + 4 + channel] * mis * weight;
              finite &&= Number.isFinite(radiance) && radiance >= 0;
              image[pixel * 3 + channel] += radiance / 1024;
            }
          }
        }
      }
      const referenceEncoder = device.createCommandEncoder();
      referenceEncoder.copyTextureToBuffer(
        { texture: referenceTextures[1] },
        { buffer: referenceStaging, bytesPerRow: rowBytes },
        [width, height],
      );
      device.queue.submit([referenceEncoder.finish()]);
      await referenceStaging.mapAsync(GPUMapMode.READ);
      const referenceData = new Float32Array(referenceStaging.getMappedRange());
      const referenceImage = [];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const offset = (y * rowBytes) / 4 + x * 4;
          referenceImage.push(...referenceData.slice(offset, offset + 3));
        }
      referenceStaging.unmap();
      const referenceMean =
        referenceImage.reduce((sum, value) => sum + value, 0) / (pixels * 3);
      const bdptMean =
        image.reduce((sum, value) => sum + value, 0) / (pixels * 3);
      const dark = new Float32Array(quadData);
      for (let index = 0; index < scene.quads.length; index++)
        dark.fill(0, index * 24 + 20, index * 24 + 23);
      device.queue.writeBuffer(quads, 0, quadData);
      integers[37] = 0;
      let darkCleared = true;
      for (let frame = 1024; frame < 1026; frame++) {
        const values = await read(frame);
        for (let offset = 0; offset < values.length; offset += 16) {
          darkCleared &&=
            values[offset + 8] === 0 &&
            values[offset + 9] === 0 &&
            values[offset + 10] === 1 &&
            values[offset + 11] === 0;
        }
      }
      const validation = await device.popErrorScope();
      if (validation) errors.push(validation.message);
      return {
        errors,
        causticSamples,
        emptySamples,
        finite,
        confidenceValid,
        darkCleared,
        lightPathCount: passes.lightPathCount,
        width,
        height,
        image: Array.from(image),
        referenceImage,
        referenceMean,
        bdptMean,
      };
    } finally {
      passes?.destroy();
      device.destroy();
    }
  });
  test.skip(result === null, "WebGPU is unavailable in this browser.");
  expect(result.errors).toEqual([]);
  console.log({
    referenceMean: result.referenceMean,
    bdptMean: result.bdptMean,
  });
  expect(Math.abs(result.bdptMean / result.referenceMean - 1)).toBeLessThan(
    0.02,
  );
  expect(result.finite).toBe(true);
  expect(result.confidenceValid).toBe(true);
  expect(result.darkCleared).toBe(true);
  expect(result.lightPathCount).toBe(result.width * result.height);
  expect(result.causticSamples).toBeGreaterThan(0);
  expect(result.emptySamples).toBeGreaterThan(0);
  expect(Math.max(...result.image)).toBeGreaterThan(0);
  await attachBdptComparisonImage(page, result, test.info());
});
