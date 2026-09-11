import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const shader = ["common", "scene", "shade"]
  .map((name) =>
    readFileSync(
      new URL(`../src/gi/shaders/${name}.wgsl`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");

test("ReSTIR resolves glass-first diffuse paths without direct-light reservoirs", async ({
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
      const size = 64;
      const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
        const resource = device.createBuffer({
          size: data.byteLength,
          usage: usage | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(resource, 0, data);
        return resource;
      };
      const uniforms = new ArrayBuffer(224);
      const floats = new Float32Array(uniforms);
      const integers = new Uint32Array(uniforms);
      floats.set([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0]);
      integers.set([size, size, 0, 0, 1, 0], 32);
      integers[40] = 1;
      integers[42] = 8 | 128;
      integers[45] = 1;
      integers[47] = 1;
      const uniform = buffer(uniforms, GPUBufferUsage.UNIFORM);
      // Only specular light hits contribute: the emitter is deliberately absent
      // from the NEE light list, and both ReSTIR reservoirs are empty.
      const quads = buffer(
        new Float32Array([
          -10,
          2,
          -10,
          400,
          20,
          0,
          0,
          1 / 400,
          0,
          0,
          20,
          1 / 400,
          0,
          -1,
          0,
          0,
          1,
          1,
          1,
          0,
          4,
          4,
          4,
          0,
        ]),
      );
      const lights = buffer(new Float32Array(4));
      const clusters = buffer(
        new Float32Array([-10, 1.999, -10, 0, 10, 2.001, 10, 1]),
      );
      const glass = buffer(
        new Float32Array([0, 0.6, 0, 0, 0, 0, 0, 0.4, 0.8, 0.9, 1, 1.52]),
      );
      const di = buffer(new Float32Array(size * size * 8));
      const gi = buffer(new Float32Array(size * size * 16));
      const texture = (pixel) => {
        const resource = device.createTexture({
          size: [size, size],
          format: "rgba32float",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        const data = new Float32Array(size * size * 4);
        for (let i = 0; i < size * size; i++) data.set(pixel, i * 4);
        device.queue.writeTexture(
          { texture: resource },
          data,
          { bytesPerRow: size * 16 },
          [size, size],
        );
        return resource;
      };
      const depth = texture([1, 0, 0, 0]);
      const normal = texture([0, 1, 0, 0]);
      const output = device.createTexture({
        size: [size, size],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const staging = device.createBuffer({
        size: size * size * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const module = device.createShaderModule({ code });
      const diagnostics = await module.getCompilationInfo();
      errors.push(
        ...diagnostics.messages
          .filter((message) => message.type === "error")
          .map((message) => message.message),
      );
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      const sceneGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [uniform, quads, lights, clusters, glass].map(
          (resource, binding) => ({ binding, resource: { buffer: resource } }),
        ),
      });
      const shadeGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: depth.createView() },
          { binding: 1, resource: normal.createView() },
          { binding: 2, resource: { buffer: di } },
          { binding: 3, resource: { buffer: gi } },
          { binding: 4, resource: output.createView() },
        ],
      });
      const run = async () => {
        device.queue.writeBuffer(uniform, 0, uniforms);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, sceneGroup);
        pass.setBindGroup(1, shadeGroup);
        pass.dispatchWorkgroups(size / 8, size / 8);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: output },
          { buffer: staging, bytesPerRow: size * 8 },
          [size, size],
        );
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const data = new Uint16Array(staging.getMappedRange());
        const rgb = [0, 0, 0];
        let finite = true;
        for (let i = 0; i < data.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) {
            const bits = data[i + channel];
            const exponent = (bits >> 10) & 31;
            const mantissa = bits & 1023;
            finite &&= exponent !== 31 && (bits & 32768) === 0;
            rgb[channel] +=
              exponent === 0
                ? mantissa * 2 ** -24
                : (1 + mantissa / 1024) * 2 ** (exponent - 15);
          }
        }
        staging.unmap();
        return { finite, rgb: rgb.map((value) => value / (size * size)) };
      };
      const enabled = await run();
      integers[42] = 8;
      const plainRestir = await run();
      integers[42] = 128;
      const disabled = await run();
      integers[42] = 8 | 128;
      integers[47] = 0;
      const noGlass = await run();
      const validation = await device.popErrorScope();
      if (validation) errors.push(validation.message);
      return { enabled, plainRestir, disabled, noGlass, errors };
    } finally {
      device.destroy();
    }
  }, shader);
  test.skip(result === null, "requires a WebGPU adapter");
  expect(result.errors).toEqual([]);
  expect(result.enabled.finite).toBe(true);
  expect(result.enabled.rgb[2]).toBeGreaterThan(0.5);
  expect(result.enabled.rgb[2]).toBeLessThan(4);
  expect(result.enabled.rgb[0] / result.enabled.rgb[2]).toBeCloseTo(0.8, 1);
  expect(result.enabled.rgb[1] / result.enabled.rgb[2]).toBeCloseTo(0.9, 1);
  expect(result.disabled.rgb).toEqual([0, 0, 0]);
  expect(result.plainRestir.rgb).toEqual([0, 0, 0]);
  expect(result.noGlass.rgb).toEqual([0, 0, 0]);
});

test("switches ReSTIR methods and resets the glass-scene accumulation", async ({
  page,
}) => {
  await page.goto("/?restir=gi");
  const method = page.getByLabel("ReSTIR method", { exact: true });
  await expect(method).toHaveValue("gi");
  await page.getByLabel("Scene", { exact: true }).selectOption("glassShapes");
  const accumulated = page.getByTestId("stat-accumulated");
  await expect
    .poll(
      async () => {
        if (await page.getByRole("alert").count()) return "unavailable";
        return Number(await accumulated.textContent()) >= 60
          ? "ready"
          : "pending";
      },
      { timeout: 20_000 },
    )
    .not.toBe("pending");
  const notice = page.getByRole("alert");
  if (await notice.count()) {
    await expect(notice).toContainText(
      /WebGPU is not available|No WebGPU adapter/,
    );
    test.skip(true, "requires a WebGPU adapter");
  }
  for (const value of ["pt-fallback", "gi"]) {
    const before = Number(await accumulated.textContent());
    await method.selectOption(value);
    await expect(method).toHaveValue(value);
    await expect
      .poll(async () => Number(await accumulated.textContent()))
      .toBeLessThan(before);
    await expect
      .poll(async () => Number(await accumulated.textContent()))
      .toBeGreaterThanOrEqual(60);
  }
  await page.getByRole("radio", { name: "Denoised PT", exact: true }).click();
  await expect(method).toHaveCount(0);
  await page.getByRole("radio", { name: "ReSTIR", exact: true }).click();
  await expect(method).toHaveValue("gi");
});
