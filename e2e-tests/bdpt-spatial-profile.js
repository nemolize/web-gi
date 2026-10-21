import {
  validSpatialSettings,
  withFrozenSpatial,
} from "./bdpt-spatial-frozen.js";
import { splitSpatialShader } from "./bdpt-spatial-profile-shaders.js";

export const profileSpatial = async ({
  scene = "classic",
  samples = 4,
  bounces = 3,
  width = 352,
  height = 738,
  repeats = 12,
  expectedShader,
} = {}) => {
  if (
    !validSpatialSettings({ scene, samples, bounces, width, height }) ||
    !Number.isSafeInteger(repeats) ||
    repeats < 2 ||
    repeats % 2 !== 0
  )
    throw Error("Invalid spatial profiling settings");
  return withFrozenSpatial(
    { scene, samples, bounces, width, height, expectedShader },
    async ({ device, frozen, buffer, track, describe }) => {
      const domainBytes = width * height * 272;
      const domains = buffer(
        domainBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
      const layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "storage" },
          },
        ],
      });
      const group = device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { buffer: domains } }],
      });
      const split = splitSpatialShader(frozen.code);
      const splitLayout = device.createPipelineLayout({
        bindGroupLayouts: [
          ...[0, 1, 2].map((index) =>
            frozen.pipeline.getBindGroupLayout(index),
          ),
          layout,
        ],
      });
      const pipelines = { original: frozen.pipeline };
      for (const [label, code] of Object.entries(split)) {
        const module = device.createShaderModule({ label, code });
        const info = await module.getCompilationInfo();
        const failures = info.messages.filter(
          (message) => message.type === "error",
        );
        if (failures.length)
          throw Error(failures.map((message) => message.message).join("\n"));
        pipelines[label] = await device.createComputePipelineAsync({
          label,
          layout: splitLayout,
          compute: { ...frozen.descriptor.compute, module },
        });
      }
      const query = track(
        device.createQuerySet({ type: "timestamp", count: 6 }),
      );
      const resolve = buffer(
        48,
        GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      );
      const times = buffer(
        48,
        GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      );
      const readback = buffer(
        frozen.output.size,
        GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      );
      const domainReadback = buffer(
        domainBytes,
        GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      );
      const record = (encoder, label, index) => {
        const pass = encoder.beginComputePass({
          timestampWrites: {
            querySet: query,
            beginningOfPassWriteIndex: index * 2,
            endOfPassWriteIndex: index * 2 + 1,
          },
        });
        pass.setPipeline(pipelines[label]);
        frozen.groups.forEach((args, index) =>
          pass.setBindGroup(index, ...args),
        );
        if (label !== "original") pass.setBindGroup(3, group);
        pass.dispatchWorkgroups(...frozen.dispatch);
        pass.end();
      };
      const readOutput = async (labels) => {
        const encoder = device.createCommandEncoder();
        labels.forEach((label, index) => record(encoder, label, index));
        encoder.copyBufferToBuffer(
          frozen.output,
          0,
          readback,
          0,
          frozen.output.size,
        );
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const result = new Uint32Array(readback.getMappedRange()).slice();
        readback.unmap();
        return result;
      };
      const original = await readOutput(["original"]);
      const values = new Float32Array(original.buffer);
      let positivePixels = 0;
      for (let pixel = 0; pixel < width * height; pixel++) {
        const radiance = values.subarray(pixel * 40 + 4, pixel * 40 + 7);
        if (!radiance.every(Number.isFinite))
          throw Error("Nonfinite production radiance");
        if (radiance.some((value) => value > 0)) positivePixels++;
      }
      if (!positivePixels) throw Error("Production output has no radiance");
      const separated = await readOutput(["selection", "replay"]);
      const mismatchWords = original.reduce(
        (count, word, index) => count + Number(word !== separated[index]),
        0,
      );
      if (mismatchWords)
        throw Error(`Split differs from production in ${mismatchWords} words`);
      const domainEncoder = device.createCommandEncoder();
      domainEncoder.copyBufferToBuffer(
        domains,
        0,
        domainReadback,
        0,
        domainBytes,
      );
      device.queue.submit([domainEncoder.finish()]);
      await domainReadback.mapAsync(GPUMapMode.READ);
      const domainData = new Uint32Array(domainReadback.getMappedRange());
      let activePixels = 0;
      let acceptedNeighbors = 0;
      for (let pixel = 0; pixel < width * height; pixel++) {
        const count = domainData[pixel * 68 + 66];
        if (count > 1) {
          activePixels++;
          acceptedNeighbors += count - 1;
        }
      }
      domainReadback.unmap();
      if (samples > 0 && activePixels === 0)
        throw Error("No accepted spatial neighbors in profile");
      const runs = [];
      for (let iteration = -4; iteration < repeats; iteration++) {
        const order =
          iteration % 2 === 0
            ? ["original", "selection", "replay"]
            : ["selection", "replay", "original"];
        const encoder = device.createCommandEncoder();
        order.forEach((label, index) => record(encoder, label, index));
        encoder.resolveQuerySet(query, 0, 6, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, times, 0, 48);
        device.queue.submit([encoder.finish()]);
        await times.mapAsync(GPUMapMode.READ);
        const values = new BigUint64Array(times.getMappedRange());
        const ms = {};
        order.forEach((label, index) => {
          const begin = values[index * 2];
          const end = values[index * 2 + 1];
          if (begin === 0n || end < begin)
            throw Error("Invalid GPU timestamps");
          ms[label] = Number(end - begin) / 1e6;
        });
        times.unmap();
        if (iteration >= 0) runs.push({ order, ms });
      }
      return {
        ...describe(),
        repeats,
        warmupPairs: 4,
        mismatchWords,
        positivePixels,
        activePixels,
        acceptedNeighbors,
        runs,
      };
    },
  );
};
