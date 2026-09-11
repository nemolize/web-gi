import { createBdptInitialPasses } from "@/gi/bdpt/initial-passes";
import { createBdptPipeline } from "@/gi/bdpt/pipeline";
import spatial from "@/gi/shaders/bdpt-spatial.wgsl?raw";
import temporal from "@/gi/shaders/bdpt-temporal.wgsl?raw";

export interface BdptPasses {
  readonly initialReservoirs: GPUBuffer;
  readonly reservoirs: GPUBuffer;
  readonly lightPathCount: number;
  readonly record: (encoder: GPUCommandEncoder, scene: GPUBindGroup) => void;
  readonly resetHistory: () => void;
  readonly destroy: () => void;
}

export const createBdptPasses = async (
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  width: number,
  height: number,
): Promise<BdptPasses> => {
  const initial = await createBdptInitialPasses(
    device,
    sceneLayout,
    width,
    height,
  );
  const resources: GPUBuffer[] = [];
  try {
    const layout = (types: readonly GPUBufferBindingType[]) =>
      device.createBindGroupLayout({
        entries: types.map((type, binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type },
        })),
      });
    const temporalLayout = layout([
      "read-only-storage",
      "read-only-storage",
      "storage",
    ]);
    const spatialLayout = layout(["read-only-storage", "storage"]);
    const [temporalPipeline, spatialPipeline] = await Promise.all([
      createBdptPipeline(
        device,
        sceneLayout,
        "bdpt-temporal",
        temporal,
        temporalLayout,
      ),
      createBdptPipeline(
        device,
        sceneLayout,
        "bdpt-spatial",
        spatial,
        spatialLayout,
      ),
    ]);
    const buffer = (label: string) => {
      const result = device.createBuffer({
        label,
        size: width * height * 128,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });
      resources.push(result);
      return result;
    };
    const scratch = buffer("bdpt-temporal");
    const history = [
      buffer("bdpt-history-0"),
      buffer("bdpt-history-1"),
    ] as const;
    const bind = (
      passLayout: GPUBindGroupLayout,
      buffers: readonly GPUBuffer[],
    ) =>
      device.createBindGroup({
        layout: passLayout,
        entries: buffers.map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      });
    const temporalGroups = [
      bind(temporalLayout, [initial.reservoirs, history[1], scratch]),
      bind(temporalLayout, [initial.reservoirs, history[0], scratch]),
    ];
    const spatialGroups = history.map((destination) =>
      bind(spatialLayout, [scratch, destination]),
    );
    let parity = 0;
    let output: GPUBuffer = history[0];
    let reset = true;
    return {
      initialReservoirs: initial.reservoirs,
      get reservoirs() {
        return output;
      },
      lightPathCount: initial.lightPathCount,
      resetHistory: () => {
        reset = true;
      },
      record: (encoder, sceneGroup) => {
        initial.record(encoder, sceneGroup);
        if (reset) {
          history.forEach((resource) => encoder.clearBuffer(resource));
          reset = false;
        }
        const pass = encoder.beginComputePass({ label: "bdpt-reuse" });
        pass.setBindGroup(0, sceneGroup);
        pass.setPipeline(temporalPipeline);
        pass.setBindGroup(1, temporalGroups[parity]);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.setPipeline(spatialPipeline);
        pass.setBindGroup(1, spatialGroups[parity]);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        output = parity === 0 ? history[0] : history[1];
        parity = 1 - parity;
      },
      destroy: () => {
        initial.destroy();
        resources.forEach((resource) => resource.destroy());
      },
    };
  } catch (error) {
    initial.destroy();
    resources.forEach((resource) => resource.destroy());
    throw error;
  }
};
