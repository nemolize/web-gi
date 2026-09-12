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

export type BdptDispatchRegion = readonly [
  originX: number,
  originY: number,
  width: number,
  height: number,
];

export type BdptCheckpoint = (
  encoder: GPUCommandEncoder,
  label: string,
  region?: BdptDispatchRegion,
) => GPUCommandEncoder;

export interface BdptDispatch {
  readonly buffer: GPUBuffer;
  readonly group: GPUBindGroup;
  readonly regions: readonly BdptDispatchRegion[];
  readonly tiled: boolean;
}

const dispatchLayouts = new WeakMap<GPUDevice, GPUBindGroupLayout>();

export const getBdptDispatchLayout = (
  device: GPUDevice,
): GPUBindGroupLayout => {
  let layout = dispatchLayouts.get(device);
  if (!layout) {
    layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
      ],
    });
    dispatchLayouts.set(device, layout);
  }
  return layout;
};

export const bdptDispatchRegions = (
  width: number,
  height: number,
  maximum?: number,
): BdptDispatchRegion[] => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new RangeError(
      "BDPT dispatch dimensions must be positive safe integers.",
    );
  }
  if (
    maximum !== undefined &&
    (!Number.isSafeInteger(maximum) || maximum < 1)
  ) {
    throw new RangeError(
      "BDPT dispatch pixel limit must be a positive safe integer.",
    );
  }
  const tileWidth = Math.min(width, maximum ?? width);
  const tileHeight =
    maximum === undefined
      ? height
      : Math.min(height, Math.floor(maximum / tileWidth));
  const regions: BdptDispatchRegion[] = [];
  for (let y = 0; y < height; y += tileHeight) {
    for (let x = 0; x < width; x += tileWidth) {
      regions.push([
        x,
        y,
        Math.min(tileWidth, width - x),
        Math.min(tileHeight, height - y),
      ]);
    }
  }
  return regions;
};

export const createBdptDispatch = (
  device: GPUDevice,
  width: number,
  height: number,
  maximum?: number,
): BdptDispatch => {
  const regions = bdptDispatchRegions(width, height, maximum);
  const buffer = device.createBuffer({
    label: "bdpt-dispatch-region",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(buffer, 0, new Uint32Array([0, 0, width, height]));
    return {
      buffer,
      group: device.createBindGroup({
        layout: getBdptDispatchLayout(device),
        entries: [{ binding: 0, resource: { buffer } }],
      }),
      regions,
      tiled: maximum !== undefined,
    };
  } catch (error) {
    buffer.destroy();
    throw error;
  }
};

export type BdptProgressReporter = (
  line: string,
  compiling?: { readonly pipeline: string },
) => void;

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

export const recordBdptDispatch = (
  encoder: GPUCommandEncoder,
  compiled: BdptPipeline,
  scene: GPUBindGroup,
  group: GPUBindGroup | undefined,
  dispatch: BdptDispatch,
  checkpoint: BdptCheckpoint,
): GPUCommandEncoder => {
  if (!group) throw new Error("Missing BDPT pass bindings.");
  for (const region of dispatch.regions) {
    const pass = encoder.beginComputePass({ label: compiled.pipeline.label });
    pass.setBindGroup(0, scene);
    pass.setBindGroup(1, group);
    pass.setBindGroup(2, dispatch.group);
    dispatchBdptPipeline(pass, compiled, region[2], region[3]);
    pass.end();
    encoder = checkpoint(
      encoder,
      compiled.pipeline.label,
      dispatch.tiled ? region : undefined,
    );
  }
  return encoder;
};

const compileBdptPipeline = async (
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  label: string,
  body: string,
  passLayout: GPUBindGroupLayout,
  report?: BdptProgressReporter,
) => {
  report?.(`SHADER START ${label}`, { pipeline: label });
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
    bindGroupLayouts: [sceneLayout, passLayout, getBdptDispatchLayout(device)],
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

const compilationQueues = new WeakMap<GPUDevice, Promise<void>>();

export const createBdptPipeline = (
  ...args: Parameters<typeof compileBdptPipeline>
) => {
  const [device, sceneLayout, label, , , report] = args;
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
    const previous = compilationQueues.get(device) ?? Promise.resolve();
    report?.(`COMPILE QUEUED ${label}`);
    pipeline = previous.then(() => compileBdptPipeline(...args));
    compilationQueues.set(
      device,
      pipeline.then(
        () => undefined,
        () => undefined,
      ),
    );
    cache.set(label, pipeline);
  }
  return pipeline;
};
