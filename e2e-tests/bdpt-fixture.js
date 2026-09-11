export const runBdptProbe = async (page, code, stride, includeWall = false) => {
  return page.evaluate(
    async ({ code, stride, includeWall }) => {
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
        u.set([32, 32, 0, 0, includeWall ? 3 : 2, 1], 32);
        u[45] = 1;
        u[46] = 1;
        u[47] = 1;
        const uniform = buffer(uniforms, GPUBufferUsage.UNIFORM);
        const quadData = new Float32Array([
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
        ]);
        const wall = includeWall
          ? [
              2, 0, 10, 40, 0, 2, 0, 0.25, 0, 0, -20, 0.0025, -1, 0, 0, 0, 0.7,
              0.3, 0.2, 0, 0, 0, 0, 0,
            ]
          : [];
        const quads = buffer(new Float32Array([...quadData, ...wall]));
        const lightData = new ArrayBuffer(16);
        new Uint32Array(lightData)[0] = 1;
        new Float32Array(lightData).set([1, 1], 1);
        const lights = buffer(lightData);
        const clusters = buffer(
          new Float32Array([
            -10,
            -0.001,
            -10,
            0,
            10,
            2.001,
            10,
            includeWall ? 3 : 2,
          ]),
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
        const size = 1024 * stride * 4;
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
            (resource, binding) => ({
              binding,
              resource: { buffer: resource },
            }),
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
    },
    { code, stride, includeWall },
  );
};
