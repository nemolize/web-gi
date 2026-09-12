import { createBdptPasses } from "@/gi/bdpt/passes";
import type { BdptProgressReporter } from "@/gi/bdpt/pipeline";
import { createBdptPipeline, dispatchBdptPipeline } from "@/gi/bdpt/pipeline";
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
) => {
  const passes = await createBdptPasses(
    device,
    sceneLayout,
    width,
    height,
    report,
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
    );
    const groups = new Map<GPUBuffer, GPUBindGroup>();
    return {
      width,
      height,
      initialReservoirs: passes.initialReservoirs,
      get reservoirs() {
        return passes.reservoirs;
      },
      resetHistory: passes.resetHistory,
      destroy: passes.destroy,
      record: (
        encoder: GPUCommandEncoder,
        scene: GPUBindGroup,
        timestamps: BdptTimestamps,
      ) => {
        passes.record(encoder, scene, timestamps);
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
        const timestampWrites = timestamps("bdptResolve");
        const pass = encoder.beginComputePass({
          label: "bdpt-resolve",
          ...(timestampWrites ? { timestampWrites } : {}),
        });
        pass.setBindGroup(0, scene);
        pass.setBindGroup(1, group);
        dispatchBdptPipeline(pass, pipeline, width, height);
        pass.end();
      },
    };
  } catch (error) {
    passes.destroy();
    throw error;
  }
};

export type BdptRuntime = Awaited<ReturnType<typeof createBdptRuntime>>;
