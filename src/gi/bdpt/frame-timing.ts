import type { GpuFrameSample } from "@/gi/performance";

const QUERY_COUNT = 32;
const CHUNK_BYTES = 256;

export const summarizeBdptTimestamps = (
  times: BigUint64Array,
  chunks: readonly (readonly string[])[],
): GpuFrameSample | null => {
  const passMs: Record<string, number> = {};
  let begin: bigint | undefined;
  let end: bigint | undefined;
  for (const [chunk, labels] of chunks.entries()) {
    for (const [index, label] of labels.entries()) {
      const offset = chunk * (CHUNK_BYTES / 8) + index * 2;
      const from = times[offset];
      const to = times[offset + 1];
      if (from === undefined || to === undefined || from === 0n || to < from)
        return null;
      passMs[label] = (passMs[label] ?? 0) + Number(to - from) / 1e6;
      if (begin === undefined || from < begin) begin = from;
      if (end === undefined || to > end) end = to;
    }
  }
  return begin !== undefined && end !== undefined && end > begin
    ? { frameMs: Number(end - begin) / 1e6, passMs }
    : null;
};

export const createBdptFrameTiming = (
  device: GPUDevice,
  submissionCount: number,
) => {
  const querySet = device.createQuerySet({
    type: "timestamp",
    count: QUERY_COUNT,
  });
  const resolve = device.createBuffer({
    size: CHUNK_BYTES * submissionCount,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const staging = device.createBuffer({
    size: CHUNK_BYTES * submissionCount,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const chunks: string[][] = [];
  let labels: string[] = [];
  return {
    timestamps: (label: string): GPUComputePassTimestampWrites => {
      if (labels.length * 2 >= QUERY_COUNT)
        throw new Error("Too many timed passes in a BDPT submission.");
      const index = labels.length * 2;
      labels.push(label);
      return {
        querySet,
        beginningOfPassWriteIndex: index,
        endOfPassWriteIndex: index + 1,
      };
    },
    checkpoint: (encoder: GPUCommandEncoder) => {
      if (chunks.length >= submissionCount)
        throw new Error("Too many timed BDPT submissions.");
      if (labels.length > 0) {
        const offset = chunks.length * CHUNK_BYTES;
        encoder.resolveQuerySet(
          querySet,
          0,
          labels.length * 2,
          resolve,
          offset,
        );
        encoder.copyBufferToBuffer(
          resolve,
          offset,
          staging,
          offset,
          labels.length * 16,
        );
      }
      chunks.push(labels);
      labels = [];
    },
    read: async (): Promise<GpuFrameSample | null> => {
      await staging.mapAsync(GPUMapMode.READ);
      try {
        return summarizeBdptTimestamps(
          new BigUint64Array(staging.getMappedRange()),
          chunks,
        );
      } finally {
        staging.unmap();
      }
    },
    destroy: () => {
      querySet.destroy();
      resolve.destroy();
      staging.destroy();
    },
  };
};

export type BdptFrameTiming = ReturnType<typeof createBdptFrameTiming>;
