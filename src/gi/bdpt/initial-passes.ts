import { allocateBdptResources } from "@/gi/bdpt/allocation";
import { createBdptPipeline, dispatchBdptPipeline } from "@/gi/bdpt/pipeline";
import cameraPass from "@/gi/shaders/bdpt-initial-camera.wgsl?raw";
import gatherPass from "@/gi/shaders/bdpt-initial-gather.wgsl?raw";
import lightPass from "@/gi/shaders/bdpt-initial-light.wgsl?raw";

export interface BdptInitialPasses {
  readonly reservoirs: GPUBuffer;
  readonly lightPathCount: number;
  readonly record: (
    encoder: GPUCommandEncoder,
    scene: GPUBindGroup,
    timestampWrites?: GPUComputePassTimestampWrites,
  ) => void;
  readonly destroy: () => void;
}

export const createBdptInitialPasses = async (
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  width: number,
  height: number,
  report?: (line: string) => void,
): Promise<BdptInitialPasses> => {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    pixels * 192 >
      Math.min(
        device.limits.maxBufferSize,
        device.limits.maxStorageBufferBindingSize,
      ) ||
    Math.max(width, height) > device.limits.maxComputeWorkgroupsPerDimension
  ) {
    throw new RangeError(
      "BDPT render dimensions exceed the device's storage or dispatch limits.",
    );
  }
  const layout = (types: readonly GPUBufferBindingType[]) =>
    device.createBindGroupLayout({
      entries: types.map((type, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type },
      })),
    });
  const cameraLayout = layout(["storage"]);
  const lightLayout = layout(["storage", "storage"]);
  const gatherLayout = layout([
    "read-only-storage",
    "read-only-storage",
    "read-only-storage",
    "storage",
  ]);
  const [cameraPipeline, lightPipeline, gatherPipeline] = await Promise.all([
    createBdptPipeline(
      device,
      sceneLayout,
      "bdpt-initial-camera",
      cameraPass,
      cameraLayout,
      report,
    ),
    createBdptPipeline(
      device,
      sceneLayout,
      "bdpt-initial-light",
      lightPass,
      lightLayout,
      report,
    ),
    createBdptPipeline(
      device,
      sceneLayout,
      "bdpt-initial-gather",
      gatherPass,
      gatherLayout,
      report,
    ),
  ]);
  const resources: GPUBuffer[] = [];
  const buffer = (
    label: string,
    stride: number,
    usage: number = GPUBufferUsage.STORAGE,
  ) => {
    const result = device.createBuffer({ label, size: pixels * stride, usage });
    resources.push(result);
    return result;
  };
  try {
    return await allocateBdptResources(device, () => {
      const cameraOutput = buffer("bdpt-camera-candidates", 80);
      const heads = buffer(
        "bdpt-light-heads",
        8,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      const nodes = buffer("bdpt-light-nodes", 192);
      const reservoirs = buffer(
        "bdpt-initial-reservoirs",
        160,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
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
      const groups = [
        bind(cameraLayout, [cameraOutput]),
        bind(lightLayout, [heads, nodes]),
        bind(gatherLayout, [cameraOutput, heads, nodes, reservoirs]),
      ];
      const pipelines = [cameraPipeline, lightPipeline, gatherPipeline];
      return {
        reservoirs,
        lightPathCount: pixels,
        record: (encoder, sceneGroup, timestampWrites) => {
          encoder.clearBuffer(heads);
          const pass = encoder.beginComputePass({
            label: "bdpt-initial",
            ...(timestampWrites ? { timestampWrites } : {}),
          });
          pass.setBindGroup(0, sceneGroup);
          pipelines.forEach((pipeline, index) => {
            pass.setBindGroup(1, groups[index]);
            dispatchBdptPipeline(pass, pipeline, width, height);
          });
          pass.end();
        },
        destroy: () => resources.forEach((resource) => resource.destroy()),
      };
    });
  } catch (error) {
    resources.forEach((resource) => resource.destroy());
    throw error;
  }
};
