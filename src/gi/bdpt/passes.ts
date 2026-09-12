import { allocateBdptResources } from "@/gi/bdpt/allocation";
import { createBdptInitialPasses } from "@/gi/bdpt/initial-passes";
import type { BdptProgressReporter } from "@/gi/bdpt/pipeline";
import { createBdptPipeline, dispatchBdptPipeline } from "@/gi/bdpt/pipeline";
import reproject from "@/gi/shaders/bdpt-caustic-reproject.wgsl?raw";
import spatial from "@/gi/shaders/bdpt-spatial.wgsl?raw";
import temporal from "@/gi/shaders/bdpt-temporal.wgsl?raw";

export interface BdptPasses {
  readonly initialReservoirs: GPUBuffer;
  readonly reservoirs: GPUBuffer;
  readonly lightPathCount: number;
  readonly record: (
    encoder: GPUCommandEncoder,
    scene: GPUBindGroup,
    timestamps?: (label: string) => GPUComputePassTimestampWrites | undefined,
  ) => void;
  readonly resetHistory: () => void;
  readonly destroy: () => void;
}

export const createBdptPasses = async (
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  width: number,
  height: number,
  report?: BdptProgressReporter,
): Promise<BdptPasses> => {
  const initial = await createBdptInitialPasses(
    device,
    sceneLayout,
    width,
    height,
    report,
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
      "storage",
    ]);
    const reprojectLayout = layout(["read-only-storage", "storage"]);
    const spatialLayout = layout(["read-only-storage", "storage"]);
    const [temporalPipeline, spatialPipeline, reprojectPipeline] =
      await Promise.all([
        createBdptPipeline(
          device,
          sceneLayout,
          "bdpt-temporal",
          temporal,
          temporalLayout,
          report,
        ),
        createBdptPipeline(
          device,
          sceneLayout,
          "bdpt-spatial",
          spatial,
          spatialLayout,
          report,
        ),
        createBdptPipeline(
          device,
          sceneLayout,
          "bdpt-caustic-reproject",
          reproject,
          reprojectLayout,
          report,
        ),
      ]);
    const buffer = (label: string, stride = 160) => {
      const result = device.createBuffer({
        label,
        size: width * height * stride,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });
      resources.push(result);
      return result;
    };
    return await allocateBdptResources(device, () => {
      const scratch = buffer("bdpt-temporal");
      const nodes = buffer("bdpt-temporal-nodes", 112);
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
        bind(temporalLayout, [initial.reservoirs, history[1], scratch, nodes]),
        bind(temporalLayout, [initial.reservoirs, history[0], scratch, nodes]),
      ];
      const reprojectGroups = [
        bind(reprojectLayout, [history[1], nodes]),
        bind(reprojectLayout, [history[0], nodes]),
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
        record: (encoder, sceneGroup, timestamps) => {
          initial.record(encoder, sceneGroup, timestamps?.("bdptInitial"));
          if (reset) {
            history.forEach((resource) => encoder.clearBuffer(resource));
            reset = false;
          }
          encoder.clearBuffer(nodes);
          const timestampWrites = timestamps?.("bdptReuse");
          const pass = encoder.beginComputePass({
            label: "bdpt-reuse",
            ...(timestampWrites ? { timestampWrites } : {}),
          });
          pass.setBindGroup(0, sceneGroup);
          pass.setBindGroup(1, reprojectGroups[parity]);
          dispatchBdptPipeline(pass, reprojectPipeline, width, height);
          pass.setBindGroup(1, temporalGroups[parity]);
          dispatchBdptPipeline(pass, temporalPipeline, width, height);
          pass.setBindGroup(1, spatialGroups[parity]);
          dispatchBdptPipeline(pass, spatialPipeline, width, height);
          pass.end();
          output = parity === 0 ? history[0] : history[1];
          parity = 1 - parity;
        },
        destroy: () => {
          initial.destroy();
          resources.forEach((resource) => resource.destroy());
        },
      };
    });
  } catch (error) {
    initial.destroy();
    resources.forEach((resource) => resource.destroy());
    throw error;
  }
};
