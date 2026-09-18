import baselineSource from "@/gi/shaders/bdpt-spatial.wgsl?raw";

import candidateSource from "./bdpt-spatial-candidate.wgsl?raw";
import type { SpatialComparisonHost } from "./bdpt-spatial-comparison";
import { readFrozenSpatial } from "./frozen-spatial";
import {
  instrumentSpatialWeights,
  TRACE_BYTES,
  TRACE_ROWS,
  TRACE_SLOTS,
} from "./spatial-weight-shader";

const header = [
  ["centerTechniqueSeeds", "u32"],
  ["centerConfidence_targetDensity_contributionWeight_weightSum", "f32"],
  ["pixelX_pixelY_domainCount_selectionState", "u32"],
  ["preparedConnection_pdf_misWeight_maxEstimator", "f32"],
  ["centerWeight_weightSum_contributionWeight_targetDensity", "f32"],
  ["selectedTechniqueSeeds", "u32"],
  ["selectionState_finalRng_selectedCenter_completed", "u32"],
] as const;
const neighbor = [
  ["pixelX_pixelY_stageFlags_selectionState", "u32"],
  ["confidence_targetDensity_contributionWeight_centerConfidence", "f32"],
  ["inverseEstimatorXYZ_jacobian", "f32"],
  ["inverseTarget_otherNumerator_pairWeight_centerWeight", "f32"],
  ["forwardEstimatorXYZ_jacobian", "f32"],
  ["ownNumerator_weight_random_accumulatedWeight", "f32"],
  ["selectedTechniqueSeeds", "u32"],
  ["forwardTarget_selectedTarget_contributionWeight_confidence", "f32"],
] as const;

export const decodeWeightTrace = (words: Uint32Array) => {
  if (words.byteLength !== TRACE_BYTES)
    throw new Error("Invalid weight trace size.");
  const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  const count = words[10] ?? 0;
  if (count > TRACE_ROWS) throw new Error("Invalid weight trace domain count.");
  const decode = (row: number, fields: typeof header | typeof neighbor) =>
    Object.fromEntries(
      fields.map(([name, type], slot) => {
        const offset = (row * TRACE_SLOTS + slot) * 4;
        const bits = Array.from(words.slice(offset, offset + 4));
        const values =
          type === "u32"
            ? bits
            : Array.from(floats.slice(offset, offset + 4), (value) =>
                Number.isFinite(value) ? value : String(value),
              );
        return [name, { type, bits, values }];
      }),
    );
  return {
    header: decode(0, header),
    neighbors: Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
      sourceIndex: index + 1,
      ...decode(index + 1, neighbor),
    })),
  };
};

export const traceSpatialWeights = async (
  host: SpatialComparisonHost,
  baseline: Uint32Array,
  candidate: Uint32Array,
  staging: GPUBuffer,
) => {
  const { device, runtime, signal, report } = host;
  const first = baseline.findIndex((word, index) => word !== candidate[index]);
  const index =
    first < 0
      ? Math.min(28, runtime.height - 1) * runtime.width +
        Math.min(6, runtime.width - 1)
      : Math.floor(first / 40);
  const pixel = {
    x: index % runtime.width,
    y: Math.floor(index / runtime.width),
  };
  const buffer = device.createBuffer({
    size: TRACE_BYTES,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: TRACE_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const results = [];
  try {
    for (const [name, source, reference] of [
      ["baseline", baselineSource, baseline],
      ["candidate", candidateSource, candidate],
    ] as const) {
      signal.throwIfAborted();
      report(
        `Tracing ${name} weights at (${pixel.x}, ${pixel.y}) outside timing windows`,
      );
      const experiment = await runtime.prepareSpatialExperiment(
        instrumentSpatialWeights(source, pixel),
        { buffer, label: `bdpt-spatial-trace-${name}-${pixel.x}-${pixel.y}` },
      );
      signal.throwIfAborted();
      device.queue.writeBuffer(buffer, 0, new Uint32Array(TRACE_BYTES / 4));
      experiment.select(true);
      try {
        const output = await readFrozenSpatial(host, experiment, staging);
        let changedWords = 0;
        for (let i = 0; i < reference.length; i++)
          if (output[i] !== reference[i]) changedWords++;
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, readback, 0, TRACE_BYTES);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        try {
          results.push({
            variant: name,
            workgroupSize: experiment.workgroups["candidate"],
            instrumentationChangedWords: changedWords,
            targetChangedWords: reference
              .slice(index * 40, (index + 1) * 40)
              .filter((word, offset) => word !== output[index * 40 + offset])
              .length,
            ...decodeWeightTrace(new Uint32Array(readback.getMappedRange())),
          });
        } finally {
          readback.unmap();
        }
      } finally {
        experiment.select(false);
      }
    }
    signal.throwIfAborted();
    return {
      version: 1,
      pixel,
      selection:
        first < 0
          ? "fallback pixel (no mismatch)"
          : "first differing output word",
      stageFlags: { visited: 1, inverse: 2, forward: 4, reservoirUpdate: 8 },
      comparable: results.every(
        (result) => result.instrumentationChangedWords === 0,
      ),
      results,
    };
  } finally {
    buffer.destroy();
    readback.destroy();
  }
};
