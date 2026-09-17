import { afterEach, expect, test, vi } from "vitest";

import { configureBdptWorkgroups } from "./pipeline";
import { createBdptRuntime } from "./runtime";

const labels = [
  "bdpt-initial-camera",
  "bdpt-initial-light",
  "bdpt-initial-gather",
  "bdpt-caustic-reproject",
  "bdpt-temporal",
  "bdpt-spatial",
  "bdpt-resolve",
];

const fixture = () => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  vi.stubGlobal("GPUBufferUsage", {
    UNIFORM: 64,
    STORAGE: 128,
    COPY_SRC: 4,
    COPY_DST: 8,
  });
  const records = [];
  const device = {
    limits: {
      maxBufferSize: 1 << 28,
      maxStorageBufferBindingSize: 1 << 27,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    createShaderModule: () => ({
      getCompilationInfo: async () => ({ messages: [] }),
    }),
    createBindGroupLayout: (descriptor) => descriptor,
    createPipelineLayout: (descriptor) => descriptor,
    createComputePipelineAsync: async (descriptor) => descriptor,
    createBindGroup: (descriptor) => descriptor,
    createBuffer: (descriptor) => ({
      ...descriptor,
      slots: new Map(),
      destroy: vi.fn(),
    }),
    queue: {
      writeBuffer: (buffer, offset, data) =>
        buffer.slots.set(offset, Array.from(data)),
    },
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
  };
  const createEncoder = () => {
    const encoder = {
      clearBuffer: vi.fn(),
      beginComputePass: () => {
        const bindings = new Map();
        let pipeline;
        let ended = false;
        return {
          setBindGroup: (index, group, offsets = []) => {
            const dynamic = group.layout.entries.filter(
              (entry) => entry.buffer?.hasDynamicOffset,
            );
            expect(offsets).toHaveLength(dynamic.length);
            bindings.set(index, { group, offsets });
          },
          setPipeline: (value) => {
            pipeline = value;
          },
          dispatchWorkgroups: (x, y) => {
            expect(ended).toBe(false);
            const { group, offsets } = bindings.get(2);
            expect(group.layout).toBe(pipeline.layout.bindGroupLayouts[2]);
            expect(group.layout.entries[0].buffer.hasDynamicOffset).toBe(true);
            const resource = group.entries[0].resource;
            const region = resource.buffer.slots.get(
              resource.offset + offsets[0],
            );
            expect(region).toBeDefined();
            records.push({
              encoder,
              label: pipeline.label,
              region,
              workgroups: [x, y],
            });
          },
          end: () => {
            ended = true;
          },
        };
      },
    };
    return encoder;
  };
  const scene = { layout: { entries: [] } };
  return { device, records, createEncoder, scene };
};

afterEach(() => vi.unstubAllGlobals());

for (const workgroupSize of [1, 4, 8]) {
  test(`untiled runtime binds the full image in every pass at ${workgroupSize}x${workgroupSize}`, async () => {
    const { device, records, createEncoder, scene } = fixture();
    configureBdptWorkgroups(device, `?bdptWorkgroupSize=${workgroupSize}`);
    const runtime = await createBdptRuntime(device, scene.layout, 13, 7, {});
    try {
      for (let frame = 0; frame < 2; frame++) {
        records.length = 0;
        const encoder = createEncoder();
        expect(runtime.record(encoder, scene, () => undefined)).toBe(encoder);
        expect(records.map(({ label }) => label)).toEqual(labels);
        for (const record of records) {
          expect(record.region).toEqual([0, 0, 13, 7]);
          expect(record.workgroups).toEqual([
            Math.ceil(13 / workgroupSize),
            Math.ceil(7 / workgroupSize),
          ]);
        }
      }
    } finally {
      runtime.destroy();
    }
  });
}

for (const cap of [undefined, 5, 26]) {
  test(`checkpoint runtime reports matching regions and covers each pixel once with cap ${cap}`, async () => {
    const { device, records, createEncoder, scene } = fixture();
    const runtime = await createBdptRuntime(
      device,
      scene.layout,
      13,
      7,
      {},
      undefined,
      cap,
    );
    let nextEncoder = createEncoder();
    const checkpoint = vi.fn((encoder, label, region) => {
      const dispatched = records.at(-1);
      expect(encoder).toBe(nextEncoder);
      expect(dispatched.encoder).toBe(encoder);
      expect(label).toBe(dispatched.label);
      expect(region).toEqual(cap === undefined ? undefined : dispatched.region);
      nextEncoder = createEncoder();
      return nextEncoder;
    });
    try {
      expect(
        runtime.record(nextEncoder, scene, () => undefined, checkpoint),
      ).toBe(nextEncoder);
      expect(checkpoint).toHaveBeenCalledTimes(records.length);
      expect([...new Set(records.map(({ label }) => label))]).toEqual(labels);
      for (const label of labels) {
        const coverage = new Uint32Array(13 * 7);
        for (const {
          region: [x, y, w, h],
          workgroups,
        } of records.filter((record) => record.label === label)) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(w).toBeGreaterThan(0);
          expect(h).toBeGreaterThan(0);
          expect(x + w).toBeLessThanOrEqual(13);
          expect(y + h).toBeLessThanOrEqual(7);
          expect(w * h).toBeLessThanOrEqual(cap ?? 91);
          expect(workgroups).toEqual([Math.ceil(w / 8), Math.ceil(h / 8)]);
          for (let row = y; row < y + h; row++)
            for (let column = x; column < x + w; column++)
              coverage[row * 13 + column]++;
        }
        expect(Array.from(coverage)).toEqual(Array(91).fill(1));
      }
    } finally {
      runtime.destroy();
    }
  });
}
