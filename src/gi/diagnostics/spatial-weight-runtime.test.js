import { expect, it, vi } from "vitest";

import { readFrozenSpatial } from "./frozen-spatial";
import { TRACE_BYTES } from "./spatial-weight-shader";
import { traceSpatialWeights } from "./spatial-weight-trace";
vi.mock("./frozen-spatial", () => ({ readFrozenSpatial: vi.fn() }));

it("uses distinct pipeline cache identities when the first mismatch moves", async () => {
  vi.stubGlobal("GPUBufferUsage", {
    STORAGE: 1,
    COPY_SRC: 2,
    COPY_DST: 4,
    MAP_READ: 8,
  });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  const compiled = [];
  const buffer = () => ({
    destroy() {},
    mapAsync: async () => {},
    unmap() {},
    getMappedRange: () => new ArrayBuffer(TRACE_BYTES),
  });
  const host = {
    signal: new AbortController().signal,
    report() {},
    device: {
      createBuffer: buffer,
      createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish() {} }),
      queue: { writeBuffer() {}, submit() {} },
    },
    runtime: {
      width: 48,
      height: 64,
      prepareSpatialExperiment: async (source, trace) => {
        compiled.push({ label: trace.label, source });
        return { select() {}, workgroups: { candidate: 4 } };
      },
    },
  };
  const reference = new Uint32Array(48 * 64 * 40);
  vi.mocked(readFrozenSpatial).mockResolvedValue(reference);
  try {
    for (const [x, y] of [
      [6, 28],
      [9, 31],
    ]) {
      const candidateWords = reference.slice();
      candidateWords[(y * 48 + x) * 40 + 8] = 1;
      const result = await traceSpatialWeights(
        host,
        reference,
        candidateWords,
        buffer(),
      );
      expect(result.pixel).toEqual({ x, y });
    }
    expect(new Set(compiled.map((entry) => entry.label)).size).toBe(4);
    expect(compiled[0]?.source).toContain("vec2u(6u, 28u)");
    expect(compiled[2]?.source).toContain("vec2u(9u, 31u)");
  } finally {
    vi.unstubAllGlobals();
  }
});
