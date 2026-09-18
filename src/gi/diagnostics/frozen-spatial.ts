import {
  bdptSubmissionBatch,
  submitBdptFrame,
} from "@/gi/bdpt/frame-submissions";
import type { BdptSpatialExperiment } from "@/gi/bdpt/passes";

import type { SpatialComparisonHost } from "./bdpt-spatial-comparison";

export const readFrozenSpatial = async (
  host: SpatialComparisonHost,
  experiment: BdptSpatialExperiment,
  staging: GPUBuffer,
) => {
  const { device, runtime, scene, signal } = host;
  signal.throwIfAborted();
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
  encoder.copyBufferToBuffer(runtime.reservoirs, 0, staging, 0, staging.size);
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
    return new Uint32Array(staging.getMappedRange()).slice();
  } finally {
    staging.unmap();
  }
};
