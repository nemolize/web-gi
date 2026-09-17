import { createBdptPasses } from "@/gi/bdpt/passes";
import type { BdptCheckpoint, BdptProgressReporter } from "@/gi/bdpt/pipeline";
import {
  createBdptPipeline,
  dispatchBdptPipeline,
  recordBdptDispatch,
} from "@/gi/bdpt/pipeline";
import resolve from "@/gi/shaders/bdpt-resolve.wgsl?raw";

export type BdptTimestamps = (
  label: string,
) => GPUComputePassTimestampWrites | undefined;

export const createBdptRuntime = async (
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  width: number,
  height: number,
  output: GPUTextureView,
  report?: BdptProgressReporter,
  maxDispatchPixels?: number,
  maxVertices = 32,
) => {
  const passes = await createBdptPasses(
    device,
    sceneLayout,
    width,
    height,
    report,
    maxDispatchPixels,
    maxVertices,
  );
  try {
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba16float" },
        },
      ],
    });
    const pipeline = await createBdptPipeline(
      device,
      sceneLayout,
      "bdpt-resolve",
      resolve,
      layout,
      report,
      maxVertices,
    );
    const groups = new Map<GPUBuffer, GPUBindGroup>();
    return {
      workgroups: {
        ...passes.workgroups,
        [pipeline.pipeline.label]: pipeline.workgroupSize,
      },
      prepareSpatialExperiment: passes.prepareSpatialExperiment,
      width,
      height,
      maxVertices,
      submissionCount: passes.dispatch.regions.length * 7,
      initialReservoirs: passes.initialReservoirs,
      dispatchRegion: passes.dispatchRegion,
      get reservoirs() {
        return passes.reservoirs;
      },
      resetHistory: passes.resetHistory,
      destroy: passes.destroy,
      record: (
        encoder: GPUCommandEncoder,
        scene: GPUBindGroup,
        timestamps: BdptTimestamps,
        checkpoint?: BdptCheckpoint,
      ) => {
        encoder = passes.record(encoder, scene, timestamps, checkpoint);
        let group = groups.get(passes.reservoirs);
        if (!group) {
          group = device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: passes.reservoirs } },
              { binding: 1, resource: output },
            ],
          });
          groups.set(passes.reservoirs, group);
        }
        if (checkpoint) {
          return recordBdptDispatch(
            encoder,
            pipeline,
            scene,
            group,
            passes.dispatch,
            checkpoint,
            timestamps,
          );
        }
        const timestampWrites = timestamps("bdptResolve");
        const pass = encoder.beginComputePass({
          label: "bdpt-resolve",
          ...(timestampWrites ? { timestampWrites } : {}),
        });
        pass.setBindGroup(0, scene);
        pass.setBindGroup(1, group);
        pass.setBindGroup(2, passes.dispatch.group, [0]);
        dispatchBdptPipeline(pass, pipeline, width, height);
        pass.end();
        return encoder;
      },
    };
  } catch (error) {
    passes.destroy();
    throw error;
  }
};

export type BdptRuntime = Awaited<ReturnType<typeof createBdptRuntime>>;
