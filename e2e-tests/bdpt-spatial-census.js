import {
  CENSUS_ACCEPTED_INDEX,
  CENSUS_PHASES,
  CENSUS_REPLAY_FIELDS,
  CENSUS_SHIFT_BASE,
  CENSUS_SHIFT_FIELDS,
  CENSUS_STRIDE_BYTES,
  CENSUS_WORDS,
  censusSpatialShader,
} from "./bdpt-spatial-census-shader.js";
import {
  validSpatialSettings,
  withFrozenSpatial,
} from "./bdpt-spatial-frozen.js";

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const profileSpatialCensus = async ({
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
    throw Error("Invalid spatial census settings");
  return withFrozenSpatial(
    { scene, samples, bounces, width, height, expectedShader },
    async ({ device, frozen, buffer, track, describe }) => {
      const censusBytes = width * height * CENSUS_STRIDE_BYTES;
      const census = buffer(
        censusBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
      const censusReadback = buffer(
        censusBytes,
        GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
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
        entries: [{ binding: 0, resource: { buffer: census } }],
      });
      const module = device.createShaderModule({
        label: "census",
        code: censusSpatialShader(frozen.code),
      });
      const failures = (await module.getCompilationInfo()).messages.filter(
        (message) => message.type === "error",
      );
      if (failures.length)
        throw Error(failures.map((message) => message.message).join("\n"));
      const pipelines = {
        original: frozen.pipeline,
        census: await device.createComputePipelineAsync({
          label: "census",
          layout: device.createPipelineLayout({
            bindGroupLayouts: [
              ...[0, 1, 2].map((index) =>
                frozen.pipeline.getBindGroupLayout(index),
              ),
              layout,
            ],
          }),
          compute: { ...frozen.descriptor.compute, module },
        }),
      };
      const query = track(
        device.createQuerySet({ type: "timestamp", count: 4 }),
      );
      const resolve = buffer(
        32,
        GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      );
      const times = buffer(
        32,
        GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      );
      const readback = buffer(
        frozen.output.size,
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
        if (label === "census") pass.setBindGroup(3, group);
        pass.dispatchWorkgroups(...frozen.dispatch);
        pass.end();
      };
      const readOutput = async (label) => {
        const encoder = device.createCommandEncoder();
        record(encoder, label, 0);
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
      const original = await readOutput("original");
      const counted = await readOutput("census");
      const mismatchWords = original.reduce(
        (count, word, index) => count + Number(word !== counted[index]),
        0,
      );
      if (mismatchWords)
        throw Error(`Census differs from production in ${mismatchWords} words`);
      const values = new Float32Array(original.buffer);
      let positivePixels = 0;
      for (let pixel = 0; pixel < width * height; pixel++) {
        const radiance = values.subarray(pixel * 40 + 4, pixel * 40 + 7);
        if (!radiance.every(Number.isFinite))
          throw Error("Nonfinite production radiance");
        if (radiance.some((value) => value > 0)) positivePixels++;
      }
      if (!positivePixels) throw Error("Production output has no radiance");
      const censusEncoder = device.createCommandEncoder();
      censusEncoder.copyBufferToBuffer(
        census,
        0,
        censusReadback,
        0,
        censusBytes,
      );
      device.queue.submit([censusEncoder.finish()]);
      await censusReadback.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(censusReadback.getMappedRange());
      const totals = new Array(CENSUS_WORDS).fill(0);
      let activePixels = 0;
      for (let pixel = 0; pixel < width * height; pixel++) {
        for (let word = 0; word < CENSUS_WORDS; word++)
          totals[word] += words[pixel * CENSUS_WORDS + word];
        if (words[pixel * CENSUS_WORDS + CENSUS_ACCEPTED_INDEX] > 0)
          activePixels++;
      }
      censusReadback.unmap();
      if (samples > 0 && activePixels === 0)
        throw Error("No accepted spatial neighbors in census");
      const replays = {};
      CENSUS_PHASES.forEach((phase, phaseIndex) => {
        replays[phase] = Object.fromEntries(
          CENSUS_REPLAY_FIELDS.map((field, fieldIndex) => [
            field,
            totals[phaseIndex * CENSUS_REPLAY_FIELDS.length + fieldIndex],
          ]),
        );
      });
      const shifts = Object.fromEntries(
        CENSUS_SHIFT_FIELDS.map((field, index) => [
          field,
          totals[CENSUS_SHIFT_BASE + index],
        ]),
      );
      const runs = [];
      for (let iteration = -4; iteration < repeats; iteration++) {
        const order =
          iteration % 2 === 0 ? ["original", "census"] : ["census", "original"];
        const encoder = device.createCommandEncoder();
        order.forEach((label, index) => record(encoder, label, index));
        encoder.resolveQuerySet(query, 0, 4, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, times, 0, 32);
        device.queue.submit([encoder.finish()]);
        await times.mapAsync(GPUMapMode.READ);
        const stamps = new BigUint64Array(times.getMappedRange());
        const ms = {};
        order.forEach((label, index) => {
          const begin = stamps[index * 2];
          const end = stamps[index * 2 + 1];
          if (begin === 0n || end < begin)
            throw Error("Invalid GPU timestamps");
          ms[label] = Number(end - begin) / 1e6;
        });
        times.unmap();
        if (iteration >= 0) runs.push({ order, ms });
      }
      const ratios = runs.map((run) => run.ms.census / run.ms.original);
      const ratioMin = Math.min(...ratios);
      const ratioMax = Math.max(...ratios);
      return {
        ...describe(),
        repeats,
        warmupPairs: 4,
        mismatchWords,
        positivePixels,
        activePixels,
        acceptedNeighbors: totals[CENSUS_ACCEPTED_INDEX],
        replays,
        shifts,
        runs,
        overhead: {
          medianRatio: median(ratios),
          ratioMin,
          ratioMax,
          distorted: !(ratioMin <= 1 && 1 <= ratioMax),
        },
      };
    },
  );
};
