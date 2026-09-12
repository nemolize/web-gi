import camera from "@/gi/shaders/bdpt-camera.wgsl?raw";
import candidate from "@/gi/shaders/bdpt-candidate.wgsl?raw";
import initial from "@/gi/shaders/bdpt-initial.wgsl?raw";
import mis from "@/gi/shaders/bdpt-mis.wgsl?raw";
import motion from "@/gi/shaders/bdpt-motion.wgsl?raw";
import replay from "@/gi/shaders/bdpt-replay.wgsl?raw";
import resampling from "@/gi/shaders/bdpt-resampling.wgsl?raw";
import reservoir from "@/gi/shaders/bdpt-reservoir.wgsl?raw";
import subpath from "@/gi/shaders/bdpt-subpath.wgsl?raw";
import transport from "@/gi/shaders/bdpt-transport.wgsl?raw";
import common from "@/gi/shaders/common.wgsl?raw";
import scene from "@/gi/shaders/scene.wgsl?raw";

export const bdptShaderPrefix = [
  common,
  scene,
  resampling,
  transport,
  subpath,
  camera,
  mis,
  candidate,
  replay,
  reservoir,
  initial,
  motion,
].join("\n");

export interface BdptPipeline {
  readonly pipeline: GPUComputePipeline;
  readonly workgroupSize: number;
}

export const dispatchBdptPipeline = (
  pass: GPUComputePassEncoder,
  compiled: BdptPipeline,
  width: number,
  height: number,
): void => {
  pass.setPipeline(compiled.pipeline);
  pass.dispatchWorkgroups(
    Math.ceil(width / compiled.workgroupSize),
    Math.ceil(height / compiled.workgroupSize),
  );
};

const compileBdptPipeline = async (
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  label: string,
  body: string,
  passLayout: GPUBindGroupLayout,
  report?: (line: string) => void,
) => {
  report?.(`SHADER START ${label}`);
  const module = device.createShaderModule({
    label,
    code: `${bdptShaderPrefix}\n${body}`,
  });
  const diagnostics = await module.getCompilationInfo();
  const errors = diagnostics.messages.filter(
    (message) => message.type === "error",
  );
  if (errors.length > 0)
    throw new Error(
      `${label}: ${errors.map((message) => message.message).join("\n")}`,
    );
  report?.(`SHADER READY ${label}`);
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [sceneLayout, passLayout],
  });
  const failures: string[] = [];
  for (const workgroupSize of [8, 4, 1]) {
    report?.(`COMPILE START ${label} / ${workgroupSize}x${workgroupSize}`);
    try {
      const pipeline = await device.createComputePipelineAsync({
        label,
        layout,
        compute: {
          module,
          entryPoint: "main",
          constants: { BDPT_WORKGROUP_SIZE: workgroupSize },
        },
      });
      report?.(`COMPILE PASS ${label} / ${workgroupSize}x${workgroupSize}`);
      return { pipeline, workgroupSize };
    } catch (error) {
      report?.(
        `COMPILE FAIL ${label} / ${workgroupSize}x${workgroupSize}: ${String(error)}`,
      );
      if (!(error instanceof GPUPipelineError) || error.reason !== "internal")
        throw error;
      failures.push(`${workgroupSize}x${workgroupSize}: ${error.message}`);
    }
  }
  throw new Error(
    `${label}: pipeline compilation failed at all workgroup sizes\n${failures.join("\n")}`,
  );
};

const pipelines = new WeakMap<
  GPUDevice,
  WeakMap<GPUBindGroupLayout, Map<string, Promise<BdptPipeline>>>
>();

export const createBdptPipeline = (
  ...args: Parameters<typeof compileBdptPipeline>
) => {
  const [device, sceneLayout, label] = args;
  let layouts = pipelines.get(device);
  if (!layouts) {
    layouts = new WeakMap();
    pipelines.set(device, layouts);
  }
  let cache = layouts.get(sceneLayout);
  if (!cache) {
    cache = new Map();
    layouts.set(sceneLayout, cache);
  }
  let pipeline = cache.get(label);
  if (!pipeline) {
    pipeline = compileBdptPipeline(...args);
    cache.set(label, pipeline);
  }
  return pipeline;
};
