import {
  bdptSubmissionBatch,
  submitBdptFrame,
} from "@/gi/bdpt/frame-submissions";
import type { BdptSpatialExperiment } from "@/gi/bdpt/passes";
import type { BdptRuntime } from "@/gi/bdpt/runtime";
import type { GpuFrameSample } from "@/gi/performance";
import { summarizeDurations } from "@/gi/performance";

import candidateSource from "./bdpt-spatial-candidate.wgsl?raw";

export interface SpatialComparisonHost {
  readonly device: GPUDevice;
  readonly runtime: BdptRuntime;
  readonly scene: GPUBindGroup;
  readonly signal: AbortSignal;
  readonly report: (line: string) => void;
  readonly reset: () => void;
  readonly frame: () => Promise<GpuFrameSample>;
}

const verifyFrozen = async (
  host: SpatialComparisonHost,
  experiment: BdptSpatialExperiment,
) => {
  const { device, runtime, scene, signal } = host;
  const staging = device.createBuffer({
    size: runtime.reservoirs.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let baseline: Uint32Array | undefined;
  const mismatches: number[] = [];
  try {
    for (const candidate of [false, true, false]) {
      signal.throwIfAborted();
      experiment.select(candidate);
      const commands: { label: string; finish: () => GPUCommandBuffer }[] = [];
      const spatialEncoder = device.createCommandEncoder();
      spatialEncoder.clearBuffer(runtime.reservoirs);
      const encoder = experiment.recordFrozen(
        spatialEncoder,
        scene,
        (encoder, label) => {
          const command = encoder.finish();
          commands.push({ label, finish: () => command });
          return device.createCommandEncoder();
        },
      );
      encoder.copyBufferToBuffer(
        runtime.reservoirs,
        0,
        staging,
        0,
        staging.size,
      );
      const readback = encoder.finish();
      commands.push({ label: "readback", finish: () => readback });
      if (
        !(await submitBdptFrame(
          device.queue,
          commands,
          () => !signal.aborted,
          () => {},
          bdptSubmissionBatch(location.search),
        ))
      )
        signal.throwIfAborted();
      await staging.mapAsync(GPUMapMode.READ);
      try {
        const words = new Uint32Array(staging.getMappedRange());
        if (!baseline) {
          if (!words.some((word) => word !== 0))
            throw new Error("Frozen spatial output is empty.");
          baseline = words.slice();
        } else {
          let changed = 0;
          for (let i = 0; i < words.length; i++)
            if (words[i] !== baseline[i]) changed++;
          mismatches.push(changed);
        }
      } finally {
        staging.unmap();
      }
    }
    signal.throwIfAborted();
    if (!baseline || mismatches[0] === undefined || mismatches[1] === undefined)
      throw new Error("Incomplete frozen verification.");
    return {
      comparedWords: baseline.length,
      candidateChangedWords: mismatches[0],
      baselineRepeatChangedWords: mismatches[1],
    };
  } finally {
    experiment.select(false);
    staging.destroy();
  }
};

export const runBdptSpatialComparison = async (host: SpatialComparisonHost) => {
  const { device, runtime, signal, report } = host;
  const experiment = await runtime.prepareSpatialExperiment(candidateSource);
  signal.throwIfAborted();
  const {
    vendor,
    architecture,
    device: adapterDevice,
    description,
  } = device.adapterInfo;
  const metadata = {
    schemaVersion: 1,
    kind: "bdpt-spatial-ab-a",
    capturedAt: new Date().toISOString(),
    url: location.origin + location.pathname + location.search,
    userAgent: navigator.userAgent,
    adapter: { vendor, architecture, device: adapterDevice, description },
    workgroups: {
      ...runtime.workgroups,
      "bdpt-spatial-candidate": experiment.workgroups["candidate"],
    },
    renderResolution: { width: runtime.width, height: runtime.height },
    maxVertices: runtime.maxVertices,
    submissionCount: runtime.submissionCount,
    submissionBatch: bdptSubmissionBatch(location.search),
    candidateRevision: "0a85a9783db6aa83b9f66c6f04011aa6174889a6",
    warmupFrames: 5,
    sampleFrames: 6,
    cycles: 3,
    inputPolicy:
      "Full frames reset history and frame seeds; atomic light insertion can differ. Frozen spatial checks reuse exactly the same uniforms and temporal reservoirs.",
  };
  report(JSON.stringify(metadata));
  const cycles = [];
  try {
    for (let cycle = 1; cycle <= metadata.cycles; cycle++) {
      const phases = [];
      for (const phase of ["A1", "B", "A2"] as const) {
        signal.throwIfAborted();
        experiment.select(phase === "B");
        host.reset();
        report(`Cycle ${cycle}/3 ${phase}: warming up`);
        for (let frame = 0; frame < metadata.warmupFrames; frame++)
          await host.frame();
        const samples = [];
        report(`Cycle ${cycle}/3 ${phase}: measuring`);
        for (let frame = 0; frame < metadata.sampleFrames; frame++) {
          const started = performance.now();
          const sample = await host.frame();
          const spatialMs =
            sample.passMs[
              phase === "B" ? "bdpt-spatial-candidate" : "bdpt-spatial"
            ];
          if (
            spatialMs === undefined ||
            !Number.isFinite(spatialMs) ||
            spatialMs <= 0 ||
            !Number.isFinite(sample.frameMs) ||
            sample.frameMs <= 0
          )
            throw new Error(
              "Missing or invalid GPU timestamps; comparison aborted.",
            );
          samples.push({
            ...sample,
            spatialMs,
            completionMs: performance.now() - started,
          });
        }
        const result = {
          phase,
          frameMs: summarizeDurations(samples.map((sample) => sample.frameMs)),
          spatialMs: summarizeDurations(
            samples.map((sample) => sample.spatialMs),
          ),
          completionMs: summarizeDurations(
            samples.map((sample) => sample.completionMs),
          ),
          samples,
        };
        phases.push(result);
        report(
          `${phase}: frame ${result.frameMs.median.toFixed(2)} ms, spatial ${result.spatialMs.median.toFixed(2)} ms`,
        );
      }
      report(`Cycle ${cycle}/3: checking frozen spatial output`);
      const frozen = await verifyFrozen(host, experiment);
      report(JSON.stringify({ cycle, frozen }));
      if (
        frozen.candidateChangedWords !== 0 ||
        frozen.baselineRepeatChangedWords !== 0
      )
        throw new Error("Frozen spatial output differs; comparison failed.");
      const [a1, b, a2] = phases;
      if (!a1 || !b || !a2) throw new Error("Incomplete comparison cycle.");
      cycles.push({
        cycle,
        phases,
        frozen,
        ratios: {
          candidateFrameVsA1: b.frameMs.median / a1.frameMs.median,
          candidateFrameVsA2: b.frameMs.median / a2.frameMs.median,
          candidateSpatialVsA1: b.spatialMs.median / a1.spatialMs.median,
          candidateSpatialVsA2: b.spatialMs.median / a2.spatialMs.median,
          baselineFrameDrift: a2.frameMs.median / a1.frameMs.median,
          baselineSpatialDrift: a2.spatialMs.median / a1.spatialMs.median,
        },
      });
    }
    signal.throwIfAborted();
    return { ...metadata, cycles };
  } finally {
    experiment.select(false);
  }
};
