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

const workgroupLimits = new WeakMap<GPUDevice, number>();

export const configureBdptWorkgroups = (
  device: GPUDevice,
  search: string,
  adapter?: Pick<GPUAdapterInfo, "vendor" | "architecture" | "description">,
): number => {
  const raw = new URLSearchParams(search).get("bdptWorkgroupSize");
  const fallback =
    adapter &&
    /qualcomm|adreno/i.test(
      `${adapter.vendor} ${adapter.architecture} ${adapter.description}`,
    )
      ? 4
      : 8;
  const limit = raw === "1" ? 1 : raw === "4" ? 4 : raw === "8" ? 8 : fallback;
  workgroupLimits.set(device, limit);
  return limit;
};

export const bdptVertexLimit = (
  maxBounces: number,
  glassShapeCount: number,
): number => Math.min(32, maxBounces + 3 + Math.max(4, glassShapeCount * 4));

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
  /** Stride between region slots; each tile binds at `index * regionStride`. */
  readonly regionStride: number;
}

/**
 * WebGPU's floor for `minUniformBufferOffsetAlignment`. Using the floor rather
 * than the adapter's reported limit keeps the slot layout identical on every
 * device, at the cost of padding on adapters that would allow less.
 */
export const BDPT_REGION_STRIDE = 256;

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
          // Every tile reads its own slot of one buffer, so a batch of tiles
          // can share a submission without the region uniform being rewritten
          // between them.
          buffer: { type: "uniform", hasDynamicOffset: true },
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
    size: Math.max(1, regions.length) * BDPT_REGION_STRIDE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    // Written once for the whole frame: the untiled path keeps the full image
    // in slot 0, and each tile owns the slot its dispatch binds.
    if (maximum === undefined) {
      device.queue.writeBuffer(
        buffer,
        0,
        new Uint32Array([0, 0, width, height]),
      );
    } else {
      for (const [index, region] of regions.entries()) {
        device.queue.writeBuffer(
          buffer,
          index * BDPT_REGION_STRIDE,
          new Uint32Array(region),
        );
      }
    }
    return {
      buffer,
      group: device.createBindGroup({
        layout: getBdptDispatchLayout(device),
        entries: [{ binding: 0, resource: { buffer, offset: 0, size: 16 } }],
      }),
      regions,
      tiled: maximum !== undefined,
      regionStride: BDPT_REGION_STRIDE,
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
  timestamps?: (label: string) => GPUComputePassTimestampWrites | undefined,
): GPUCommandEncoder => {
  if (!group) throw new Error("Missing BDPT pass bindings.");
  for (const [index, region] of dispatch.regions.entries()) {
    const timestampWrites = timestamps?.(compiled.pipeline.label);
    const pass = encoder.beginComputePass({
      label: compiled.pipeline.label,
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setBindGroup(0, scene);
    pass.setBindGroup(1, group);
    pass.setBindGroup(2, dispatch.group, [
      dispatch.tiled ? index * dispatch.regionStride : 0,
    ]);
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
  maximumWorkgroupSize: number,
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  label: string,
  body: string,
  passLayout: GPUBindGroupLayout,
  report?: BdptProgressReporter,
  maxVertices = 32,
) => {
  if (!Number.isInteger(maxVertices) || maxVertices < 2 || maxVertices > 32)
    throw new RangeError(
      "BDPT vertex capacity must be an integer from 2 to 32.",
    );
  const prefix = bdptShaderPrefix.replace(
    "const BDPT_MAX_VERTICES: u32 = 32u;",
    `const BDPT_MAX_VERTICES: u32 = ${String(maxVertices)}u;`,
  );
  report?.(`SHADER START ${label}`, { pipeline: label });
  const module = device.createShaderModule({
    label,
    code: `${prefix}\n${body}`,
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
  for (const workgroupSize of [8, 4, 1].filter(
    (size) => size <= maximumWorkgroupSize,
  )) {
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

type BdptPipelineArguments =
  Parameters<typeof compileBdptPipeline> extends [number, ...infer Arguments]
    ? Arguments
    : never;

export const createBdptPipeline = (...args: BdptPipelineArguments) => {
  const [device, sceneLayout, label, , , report, maxVertices = 32] = args;
  const maximumWorkgroupSize = workgroupLimits.get(device) ?? 8;
  const key = `${label}:${String(maxVertices)}:${String(maximumWorkgroupSize)}`;
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
  let pipeline = cache.get(key);
  if (!pipeline) {
    const previous = compilationQueues.get(device) ?? Promise.resolve();
    report?.(`COMPILE QUEUED ${label}`);
    pipeline = previous.then(() =>
      compileBdptPipeline(maximumWorkgroupSize, ...args),
    );
    compilationQueues.set(
      device,
      pipeline.then(
        () => undefined,
        () => undefined,
      ),
    );
    cache.set(key, pipeline);
  }
  return pipeline;
};
