import { expect, test } from "@playwright/test";

test("gather preserves camera and linked light weights at every workgroup size", async ({
  page,
}) => {
  await page.goto("/?diagnostics=bdpt");
  test.skip(
    !(await page.evaluate(async () =>
      Boolean(await navigator.gpu?.requestAdapter()),
    )),
    "WebGPU unavailable",
  );
  const source = await page.request.get("/src/gi/bdpt/pipeline.ts");
  test.skip(
    !source.headers()["content-type"]?.includes("javascript"),
    "Development modules unavailable",
  );
  const result = await page.evaluate(async () => {
    const { bdptShaderPrefix } = await import("/src/gi/bdpt/pipeline.ts");
    const { default: gather } =
      await import("/src/gi/shaders/bdpt-initial-gather.wgsl?raw");
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    try {
      const width = 17,
        height = 3,
        pixels = width * height;
      const camera = new Float32Array(pixels * 20);
      const nodes = new Float32Array(pixels * 2 * 24);
      const nodeWords = new Uint32Array(nodes.buffer);
      const heads = new Uint32Array(pixels * 2);
      const expected = Array.from({ length: pixels }, () => [0, 0]);
      const fill = (data, offset, weight) => {
        data.set([1, 1, 1, 1], offset + 4);
        data[offset + 9] = weight;
      };
      for (let pixel = 0; pixel < pixels; pixel++) {
        const weight = pixel % 3;
        fill(camera, pixel * 20, weight);
        expected[pixel][0] = weight;
      }
      for (let node = 0; node < pixels * 2; node++) {
        const domain = node % 2;
        const pixel = Math.floor(node / 2) % 7;
        const weight = 1 + (node % 3);
        fill(nodes, node * 24, weight);
        nodeWords[node * 24 + 20] = heads[pixel * 2 + domain];
        heads[pixel * 2 + domain] = node + 1;
        expected[pixel][domain] += weight;
      }
      const uniform = new Uint32Array(56);
      uniform.set([width, height, 13], 32);
      const upload = (data, usage) => {
        const buffer = device.createBuffer({
          size: data.byteLength,
          usage: usage | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      const uniformBuffer = upload(uniform, GPUBufferUsage.UNIFORM);
      const inputs = [camera, heads, nodes].map((data) =>
        upload(data, GPUBufferUsage.STORAGE),
      );
      const module = device.createShaderModule({
        code: `${bdptShaderPrefix}\n${gather}`,
      });
      const outputs = [];
      for (const size of [8, 4, 1]) {
        const pipeline = await device.createComputePipelineAsync({
          layout: "auto",
          compute: {
            module,
            entryPoint: "main",
            constants: { BDPT_WORKGROUP_SIZE: size },
          },
        });
        const output = device.createBuffer({
          size: pixels * 160,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const staging = device.createBuffer({
          size: output.size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
          }),
        );
        pass.setBindGroup(
          1,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(1),
            entries: [...inputs, output].map((buffer, binding) => ({
              binding,
              resource: { buffer },
            })),
          }),
        );
        pass.dispatchWorkgroups(
          Math.ceil(width / size),
          Math.ceil(height / size),
        );
        pass.end();
        encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(staging.getMappedRange().slice(0));
        outputs.push(
          Array.from({ length: pixels }, (_, pixel) => [
            data[pixel * 40 + 9],
            data[pixel * 40 + 29],
          ]),
        );
        staging.unmap();
        staging.destroy();
        output.destroy();
      }
      return { expected, outputs };
    } finally {
      device.destroy();
    }
  });
  for (const output of result.outputs) expect(output).toEqual(result.expected);
});
