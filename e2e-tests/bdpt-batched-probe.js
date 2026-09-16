export const runBatchedProbe = (page, workgroupSize, cap) =>
  page.evaluate(
    async ({ workgroupSize, cap }) => {
      const { createBdptRuntime } = await import("/src/gi/bdpt/runtime.ts");
      const { cameraBasis, DEFAULT_CAMERA } = await import("/src/gi/camera.ts");
      const {
        buildScene,
        packQuads,
        packLights,
        packClusters,
        packGlassShapes,
      } = await import("/src/gi/scene.ts");
      const device = await (
        await navigator.gpu.requestAdapter()
      ).requestDevice();
      const errors = [];
      const compiledSizes = [];
      device.addEventListener("uncapturederror", (event) =>
        errors.push(event.error.message),
      );
      const compile = device.createComputePipelineAsync.bind(device);
      device.createComputePipelineAsync = async (descriptor) => {
        const size = descriptor.compute.constants.BDPT_WORKGROUP_SIZE;
        if (size > workgroupSize)
          throw new GPUPipelineError("Injected workgroup fallback", {
            reason: "internal",
          });
        const pipeline = await compile(descriptor);
        compiledSizes.push(size);
        return pipeline;
      };
      const createBuffer = device.createBuffer.bind(device);
      let cameraOutput;
      device.createBuffer = (descriptor) => {
        if (descriptor.label === "bdpt-camera-candidates") {
          cameraOutput = createBuffer({
            ...descriptor,
            usage: descriptor.usage | GPUBufferUsage.COPY_SRC,
          });
          return cameraOutput;
        }
        return createBuffer(descriptor);
      };
      const width = 39,
        height = 31,
        pixels = width * height;
      try {
        const scene = buildScene("classic");
        const camera = cameraBasis(DEFAULT_CAMERA, width / height);
        const data = new ArrayBuffer(224);
        const floats = new Float32Array(data);
        const words = new Uint32Array(data);
        const xyz = (v) => [v.x, v.y, v.z];
        floats.set([
          ...xyz(camera.pos),
          camera.tanHalfFov,
          ...xyz(camera.right),
          camera.aspect,
          ...xyz(camera.up),
          0,
          ...xyz(camera.forward),
          0,
        ]);
        floats.copyWithin(16, 0, 16);
        words.set(
          [width, height, 0, 0, scene.quads.length, scene.lights.length],
          32,
        );
        words[39] = 4;
        words[40] = 3;
        words[41] = 8;
        words[42] = 256 | 9 | 48;
        floats[43] = 0.15;
        words.set(
          [
            scene.clusters.length,
            scene.occluderClusterCount,
            scene.glassShapes.length,
          ],
          45,
        );
        words.set([width, height], 50);
        const resources = [
          data,
          packQuads(scene),
          packLights(scene),
          packClusters(scene),
          packGlassShapes(scene),
        ].map((value, index) => {
          const buffer = device.createBuffer({
            size: value.byteLength,
            usage:
              GPUBufferUsage.COPY_DST |
              (index === 0 ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE),
          });
          device.queue.writeBuffer(buffer, 0, value);
          return buffer;
        });
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
        const run = async (limit) => {
          const texture = device.createTexture({
            size: [width, height],
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING,
          });
          const runtime = await createBdptRuntime(
            device,
            layout,
            width,
            height,
            texture.createView(),
            undefined,
            limit,
          );
          const capturedCamera = cameraOutput;
          const staging = device.createBuffer({
            size: pixels * (80 + 160 + 160),
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const frames = [];
          const coverageErrors = [];
          try {
            for (let frame = 0; frame < 3; frame++) {
              words[34] = words[35] = words[49] = frame;
              device.queue.writeBuffer(resources[0], 0, data);
              const commands = [];
              const coverage = new Map();
              const checkpoint =
                limit === undefined
                  ? undefined
                  : (encoder, label, region) => {
                      if (!region)
                        throw new Error(`Missing region for ${label}`);
                      const [x, y, w, h] = region;
                      if (
                        x < 0 ||
                        y < 0 ||
                        w <= 0 ||
                        h <= 0 ||
                        x + w > width ||
                        y + h > height ||
                        w * h > limit
                      )
                        coverageErrors.push({ frame, label, region });
                      const counts =
                        coverage.get(label) ?? new Uint8Array(pixels);
                      for (let row = y; row < y + h; row++)
                        for (let column = x; column < x + w; column++)
                          counts[row * width + column]++;
                      coverage.set(label, counts);
                      commands.push({ buffer: encoder.finish(), region });
                      return device.createCommandEncoder();
                    };
              const encoder = runtime.record(
                device.createCommandEncoder(),
                group,
                () => undefined,
                checkpoint,
              );
              encoder.copyBufferToBuffer(
                capturedCamera,
                0,
                staging,
                0,
                pixels * 80,
              );
              encoder.copyBufferToBuffer(
                runtime.initialReservoirs,
                0,
                staging,
                pixels * 80,
                pixels * 160,
              );
              encoder.copyBufferToBuffer(
                runtime.reservoirs,
                0,
                staging,
                pixels * 240,
                pixels * 160,
              );
              commands.push({ buffer: encoder.finish() });
              for (const command of commands) {
                if (command.region)
                  device.queue.writeBuffer(
                    runtime.dispatchRegion,
                    0,
                    new Uint32Array(command.region),
                  );
                device.queue.submit([command.buffer]);
                await device.queue.onSubmittedWorkDone();
              }
              if (limit !== undefined) {
                const labels = [...coverage.keys()].sort();
                const expected = [
                  "bdpt-initial-camera",
                  "bdpt-initial-light",
                  "bdpt-initial-gather",
                  "bdpt-caustic-reproject",
                  "bdpt-temporal",
                  "bdpt-spatial",
                  "bdpt-resolve",
                ].sort();
                if (JSON.stringify(labels) !== JSON.stringify(expected))
                  coverageErrors.push({ frame, labels });
                for (const [label, counts] of coverage)
                  if (counts.some((count) => count !== 1))
                    coverageErrors.push({
                      frame,
                      label,
                      counts: [...counts],
                    });
              }
              await staging.mapAsync(GPUMapMode.READ);
              const mapped = staging.getMappedRange();
              const values = new Float32Array(mapped);
              const cameraWords = new Uint32Array(
                mapped,
                0,
                pixels * 20,
              ).slice();
              const statistics = [pixels * 20, pixels * 60].map((offset) => {
                let sum = 0,
                  positive = 0,
                  finite = true;
                for (let pixel = 0; pixel < pixels; pixel++)
                  for (let channel = 0; channel < 3; channel++) {
                    const a = offset + pixel * 40;
                    const value =
                      values[a + 4 + channel] * values[a + 7] * values[a + 9] +
                      values[a + 24 + channel] *
                        values[a + 27] *
                        values[a + 29];
                    finite &&= Number.isFinite(value);
                    positive += Number(value > 0);
                    sum += value;
                  }
                return { finite, positive, mean: sum / (pixels * 3) };
              });
              frames.push({ cameraWords, statistics });
              staging.unmap();
            }
            return { frames, coverageErrors };
          } finally {
            runtime.destroy();
            staging.destroy();
            texture.destroy();
          }
        };
        const baseline = await run();
        const batched = await run(cap);
        return {
          errors,
          compiledSizes,
          coverageErrors: batched.coverageErrors,
          frames: batched.frames.map((frame, index) => ({
            cameraMismatches: frame.cameraWords.reduce(
              (count, word, i) =>
                count + Number(word !== baseline.frames[index].cameraWords[i]),
              0,
            ),
            baseline: baseline.frames[index].statistics,
            batched: frame.statistics,
          })),
        };
      } finally {
        device.destroy();
      }
    },
    { workgroupSize, cap },
  );
