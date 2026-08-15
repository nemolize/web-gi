import type { AtrousVariant } from "@/gi/atrous";
import {
  ATROUS_ITERATIONS,
  DEFAULT_WORKGROUP_SIZE,
  selectTiledAtrous,
  TILED_ATROUS_STORAGE_BYTES,
  TILED_ATROUS_WORKGROUP_SIZE,
} from "@/gi/atrous";
import type { CameraBasis, OrbitCamera } from "@/gi/camera";
import { cameraBasis } from "@/gi/camera";
import type { LinearImage } from "@/gi/compare";
import type {
  ComparisonContext,
  ComparisonSession,
  CompletionWindowCapture,
  LinearComparisonReport,
} from "@/gi/comparison-session";
import { createComparisonSession } from "@/gi/comparison-session";
import { installDevHooks } from "@/gi/dev-hooks";
import type { GpuFrameSample } from "@/gi/performance";
import { MAX_RENDER_PIXELS, resolveRenderSize } from "@/gi/render-size";
import type { Scene } from "@/gi/scene";
import {
  buildScene,
  CLUSTER_STRIDE_BYTES,
  GLASS_SHAPE_STRIDE_BYTES,
  LIGHT_STRIDE_BYTES,
  packClusters,
  packGlassShapes,
  packLights,
  packQuads,
  QUAD_STRIDE_BYTES,
} from "@/gi/scene";
import type { RenderSettings } from "@/gi/settings";
import { packFlags, requiresAccumulationReset } from "@/gi/settings";
import captureWgsl from "@/gi/shaders/capture.wgsl?raw";
import commonWgsl from "@/gi/shaders/common.wgsl?raw";
import atrousWgsl from "@/gi/shaders/denoise-atrous.wgsl?raw";
import atrousCommonWgsl from "@/gi/shaders/denoise-atrous-common.wgsl?raw";
import atrousFallbackWgsl from "@/gi/shaders/denoise-atrous-fallback.wgsl?raw";
import temporalWgsl from "@/gi/shaders/denoise-temporal.wgsl?raw";
import gbufferWgsl from "@/gi/shaders/gbuffer.wgsl?raw";
import pathTraceWgsl from "@/gi/shaders/path-trace.wgsl?raw";
import presentWgsl from "@/gi/shaders/present.wgsl?raw";
import referenceWgsl from "@/gi/shaders/reference.wgsl?raw";
import diWgsl from "@/gi/shaders/restir-di.wgsl?raw";
import diSpatialWgsl from "@/gi/shaders/restir-di-spatial.wgsl?raw";
import giWgsl from "@/gi/shaders/restir-gi.wgsl?raw";
import giSpatialWgsl from "@/gi/shaders/restir-gi-spatial.wgsl?raw";
import sceneWgsl from "@/gi/shaders/scene.wgsl?raw";
import shadeWgsl from "@/gi/shaders/shade.wgsl?raw";

export class WebGpuUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebGpuUnsupportedError";
  }
}

export type RendererStats = {
  readonly width: number;
  readonly height: number;
  readonly accumFrames: number;
  readonly frameMs: number;
  readonly atrousVariant: AtrousVariant | null;
};

export type DeviceLossInfo = Pick<GPUDeviceLostInfo, "message" | "reason">;

const WORKGROUP_SIZE = DEFAULT_WORKGROUP_SIZE;
const UNIFORM_BYTES = 192;
const DI_RESERVOIR_BYTES = 32;
const GI_RESERVOIR_BYTES = 48;

/** Widest per-pixel reservoir stride; bounds the storage-buffer allocations. */
const MAX_RESERVOIR_BYTES = Math.max(DI_RESERVOIR_BYTES, GI_RESERVOIR_BYTES);

/** Below this, shrinking further buys nothing worth looking at. */
const MIN_PIXEL_BUDGET = 256 * 256;

/** Compute passes plus the resolve; `ATROUS_ITERATIONS` rides inside it. */
const MAX_TIMED_PASSES = 16;

/**
 * Frames whose timings can be in flight at once. Depth grows with how far the
 * GPU trails the callback rate — four covered 96% on a desktop but under half
 * on a phone rendering at five times its display period.
 */
const PROBE_RING_SIZE = 12;
/** Amortizes queue drains while bounding cancellation lag to four reference frames. */
const REFERENCE_COMPLETION_BATCH_SIZE = 4;
const REFERENCE_CAPTURE_TIMEOUT_MS = 5 * 60_000;
const COMPLETION_WINDOW_TIMEOUT_PADDING_MS = 30_000;

type CompletionBatchOperations = {
  readonly getFrameCount: () => number;
  readonly renderFrame: () => void;
  readonly waitForSubmittedWork: () => Promise<void>;
  readonly validateAfterWait: () => void;
};

export const runCompletionBatches = async (
  requestedFrames: number,
  batchSize: number,
  operations: CompletionBatchOperations,
): Promise<boolean> => {
  if (
    !Number.isInteger(requestedFrames) ||
    requestedFrames <= 0 ||
    !Number.isInteger(batchSize) ||
    batchSize <= 0
  ) {
    throw new RangeError("Completion batches require positive frame counts.");
  }
  while (operations.getFrameCount() < requestedFrames) {
    const batchStart = operations.getFrameCount();
    const batchEnd = Math.min(requestedFrames, batchStart + batchSize);
    while (operations.getFrameCount() < batchEnd) {
      const beforeFrame = operations.getFrameCount();
      operations.renderFrame();
      if (operations.getFrameCount() === beforeFrame) {
        if (beforeFrame > batchStart) {
          await operations.waitForSubmittedWork();
          operations.validateAfterWait();
        }
        return false;
      }
    }
    await operations.waitForSubmittedWork();
    operations.validateAfterWait();
  }
  return true;
};

type ProbeSlot = {
  readonly resolve: GPUBuffer;
  readonly staging: GPUBuffer;
  busy: boolean;
};

type PassProbe = {
  readonly querySet: GPUQuerySet;
  readonly slots: readonly ProbeSlot[];
  next: number;
  /** Labels of the passes written this frame, in query-index order. */
  readonly labels: string[];
  capturing: boolean;
  readonly samples: GpuFrameSample[];
};

type Binding =
  | { readonly kind: "uniform" }
  | { readonly kind: "readOnlyStorage" }
  | { readonly kind: "storage" }
  | { readonly kind: "texture"; readonly sampleType: GPUTextureSampleType }
  | { readonly kind: "storageTexture"; readonly format: GPUTextureFormat };

const uniformBinding: Binding = { kind: "uniform" };
const readOnlyStorage: Binding = { kind: "readOnlyStorage" };
const storageBinding: Binding = { kind: "storage" };
const floatTexture: Binding = { kind: "texture", sampleType: "float" };
const rawTexture: Binding = {
  kind: "texture",
  sampleType: "unfilterable-float",
};
const storageTexture = (format: GPUTextureFormat): Binding => ({
  kind: "storageTexture",
  format,
});

const toEntry = (
  binding: Binding,
  index: number,
  visibility: number,
): GPUBindGroupLayoutEntry => {
  const base = { binding: index, visibility };
  switch (binding.kind) {
    case "uniform":
      return { ...base, buffer: { type: "uniform" } };
    case "readOnlyStorage":
      return { ...base, buffer: { type: "read-only-storage" } };
    case "storage":
      return { ...base, buffer: { type: "storage" } };
    case "texture":
      return { ...base, texture: { sampleType: binding.sampleType } };
    case "storageTexture":
      return {
        ...base,
        storageTexture: { access: "write-only", format: binding.format },
      };
  }
};

const createLayout = (
  device: GPUDevice,
  label: string,
  visibility: number,
  bindings: readonly Binding[],
): GPUBindGroupLayout =>
  device.createBindGroupLayout({
    label,
    entries: bindings.map((binding, index) =>
      toEntry(binding, index, visibility),
    ),
  });

const createBindGroup = (
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  resources: readonly GPUBindingResource[],
): GPUBindGroup =>
  device.createBindGroup({
    layout,
    entries: resources.map((resource, binding) => ({ binding, resource })),
  });

type Layouts = {
  readonly scene: GPUBindGroupLayout;
  readonly gbuffer: GPUBindGroupLayout;
  readonly resample: GPUBindGroupLayout;
  readonly spatial: GPUBindGroupLayout;
  readonly shade: GPUBindGroupLayout;
  readonly pathTrace: GPUBindGroupLayout;
  readonly reference: GPUBindGroupLayout;
  readonly temporal: GPUBindGroupLayout;
  readonly atrous: GPUBindGroupLayout;
  readonly presentUniform: GPUBindGroupLayout;
  readonly presentRestir: GPUBindGroupLayout;
  readonly presentReference: GPUBindGroupLayout;
  readonly capture: GPUBindGroupLayout;
};

type RendererPipelines<TCompute extends object, TRender extends object> = {
  readonly gbuffer: TCompute;
  readonly di: TCompute;
  readonly diSpatial: TCompute;
  readonly gi: TCompute;
  readonly giSpatial: TCompute;
  readonly shade: TCompute;
  readonly getPathTracePipeline: () => TCompute;
  readonly reference: TCompute;
  readonly temporal: TCompute;
  readonly atrous: TCompute;
  readonly presentRestir: TRender;
  readonly presentReference: TRender;
};

type Pipelines = RendererPipelines<GPUComputePipeline, GPURenderPipeline>;

/** Everything whose size depends on the render resolution. */
type Targets = {
  readonly width: number;
  readonly height: number;
  readonly textures: readonly GPUTexture[];
  readonly buffers: readonly GPUBuffer[];
  readonly gbuffer: readonly GPUBindGroup[];
  readonly di: readonly GPUBindGroup[];
  readonly diSpatial: readonly GPUBindGroup[];
  readonly gi: readonly GPUBindGroup[];
  readonly giSpatial: readonly GPUBindGroup[];
  readonly shade: readonly GPUBindGroup[];
  readonly pathTrace: readonly GPUBindGroup[];
  readonly reference: readonly GPUBindGroup[];
  readonly temporal: readonly GPUBindGroup[];
  readonly atrous: readonly (readonly GPUBindGroup[])[];
  readonly presentRestir: GPUBindGroup;
  readonly presentReference: readonly GPUBindGroup[];
  /** Kept for `captureLinearImage`, which binds them outside the frame graph. */
  readonly atrousView: GPUTextureView;
  readonly albedoView: GPUTextureView;
  readonly emissionView: GPUTextureView;
  readonly referenceViews: readonly GPUTextureView[];
};

/** Row pitch a `copyTextureToBuffer` destination must be a multiple of. */
const COPY_ALIGNMENT = 256;

/** Allocated only when a measurement asks for it; see `captureLinearImage`. */
type CaptureResources = {
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly texture: GPUTexture;
  readonly staging: GPUBuffer;
  readonly denoised: GPUBindGroup;
  readonly reference: readonly GPUBindGroup[];
};

type CapturePipelines = {
  readonly denoised: GPUComputePipeline;
  readonly reference: GPUComputePipeline;
};

const at = <T>(items: readonly T[], index: number): T => {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`Missing resource at index ${String(index)}`);
  }
  return value;
};

type PipelineAssemblyLayouts<TLayout extends object> = {
  readonly gbuffer: TLayout;
  readonly resample: TLayout;
  readonly spatial: TLayout;
  readonly shade: TLayout;
  readonly pathTrace: TLayout;
  readonly reference: TLayout;
  readonly temporal: TLayout;
  readonly atrous: TLayout;
  readonly presentRestir: TLayout;
  readonly presentReference: TLayout;
};

type ComputePipelineFactory<
  TLayout extends object,
  TPipeline extends object,
> = (label: string, body: string, passLayout: TLayout) => TPipeline;

type PresentPipelineFactory<
  TLayout extends object,
  TPipeline extends object,
> = (label: string, entryPoint: string, passLayout: TLayout) => TPipeline;

export const assembleRendererPipelines = <
  TLayout extends object,
  TCompute extends object,
  TRender extends object,
>(
  layouts: PipelineAssemblyLayouts<TLayout>,
  tiledAtrous: boolean,
  compute: ComputePipelineFactory<TLayout, TCompute>,
  present: PresentPipelineFactory<TLayout, TRender>,
): RendererPipelines<TCompute, TRender> => {
  let pathTracePipeline: TCompute | null = null;
  return {
    gbuffer: compute("gbuffer", gbufferWgsl, layouts.gbuffer),
    di: compute("restir-di", diWgsl, layouts.resample),
    diSpatial: compute("restir-di-spatial", diSpatialWgsl, layouts.spatial),
    gi: compute("restir-gi", giWgsl, layouts.resample),
    giSpatial: compute("restir-gi-spatial", giSpatialWgsl, layouts.spatial),
    shade: compute("shade", shadeWgsl, layouts.shade),
    getPathTracePipeline: () => {
      pathTracePipeline ??= compute(
        "path-trace",
        pathTraceWgsl,
        layouts.pathTrace,
      );
      return pathTracePipeline;
    },
    reference: compute("reference", referenceWgsl, layouts.reference),
    temporal: compute("denoise-temporal", temporalWgsl, layouts.temporal),
    atrous: compute(
      `denoise-atrous-${tiledAtrous ? "tiled" : "fallback"}`,
      `${atrousCommonWgsl}\n${tiledAtrous ? atrousWgsl : atrousFallbackWgsl}`,
      layouts.atrous,
    ),
    presentRestir: present("present", "fsRestir", layouts.presentRestir),
    presentReference: present(
      "present-reference",
      "fsReference",
      layouts.presentReference,
    ),
  };
};

const camerasEqual = (a: OrbitCamera, b: OrbitCamera): boolean =>
  a.target.x === b.target.x &&
  a.target.y === b.target.y &&
  a.target.z === b.target.z &&
  a.radius === b.radius &&
  a.yaw === b.yaw &&
  a.pitch === b.pitch &&
  a.fovY === b.fovY;

/**
 * WGSL compile failures otherwise surface only as "invalid pipeline" noise at
 * dispatch time, with no file, line or message.
 */
const reportShaderDiagnostics = (
  module: GPUShaderModule,
  label: string,
): void => {
  void module.getCompilationInfo().then((info) => {
    for (const message of info.messages) {
      if (message.type === "info") continue;
      const where = `${label}:${String(message.lineNum)}:${String(message.linePos)}`;
      const line = `[wgsl] ${where} ${message.message}`;
      if (message.type === "error") console.error(line);
      else console.warn(line);
    }
  });
};

const writeCamera = (
  view: DataView,
  offset: number,
  basis: CameraBasis,
): void => {
  view.setFloat32(offset, basis.pos.x, true);
  view.setFloat32(offset + 4, basis.pos.y, true);
  view.setFloat32(offset + 8, basis.pos.z, true);
  view.setFloat32(offset + 12, basis.tanHalfFov, true);
  view.setFloat32(offset + 16, basis.right.x, true);
  view.setFloat32(offset + 20, basis.right.y, true);
  view.setFloat32(offset + 24, basis.right.z, true);
  view.setFloat32(offset + 28, basis.aspect, true);
  view.setFloat32(offset + 32, basis.up.x, true);
  view.setFloat32(offset + 36, basis.up.y, true);
  view.setFloat32(offset + 40, basis.up.z, true);
  view.setFloat32(offset + 48, basis.forward.x, true);
  view.setFloat32(offset + 52, basis.forward.y, true);
  view.setFloat32(offset + 56, basis.forward.z, true);
};

export class GiRenderer {
  /**
   * Shared across instances: a device that cannot allocate at a given budget
   * fails the same way after "Retry renderer", so what one instance learned has
   * to outlive it. Reset it between tests or after the constraint is gone.
   */
  private static learnedPixelBudget = MAX_RENDER_PIXELS;

  static resetLearnedPixelBudget(): void {
    GiRenderer.learnedPixelBudget = MAX_RENDER_PIXELS;
  }

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly layouts: Layouts;
  private readonly pipelines: Pipelines;
  private readonly atrousVariant: AtrousVariant;
  private readonly atrousWorkgroupSize: number;
  private readonly uniformBuffer: GPUBuffer;
  private readonly presentUniformBindGroup: GPUBindGroup;
  private readonly atrousBuffers: readonly GPUBuffer[];
  private readonly uniformData = new ArrayBuffer(UNIFORM_BYTES);

  private capture: CaptureResources | null = null;
  private capturePipelines: CapturePipelines | null = null;
  private captureInProgress = false;
  private quadBuffer: GPUBuffer;
  private lightBuffer: GPUBuffer;
  private clusterBuffer: GPUBuffer;
  private glassShapeBuffer: GPUBuffer;
  private sceneBindGroup: GPUBindGroup;
  private scene: Scene;
  private targets: Targets | null = null;

  private settings: RenderSettings;
  private pixelBudget: number;
  private allocationFailure: string | null = null;
  private deviceIsLost = false;
  private frame = 0;
  private accumFrames = 0;
  private parity = 0;
  private previousBasis: CameraBasis | null = null;
  private lastCamera: OrbitCamera | null = null;
  private comparisonInProgress = false;
  private comparisonAbortController: AbortController | null = null;
  private comparisonGeneration = 0;
  private readonly comparisonSession: ComparisonSession;
  private lastFrameAt = 0;
  private lastFrameMs = 0;
  private destroyed = false;
  private passProbe: PassProbe | null = null;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    canvas: HTMLCanvasElement,
    format: GPUTextureFormat,
    settings: RenderSettings,
    tiledAtrous: boolean,
  ) {
    this.device = device;
    this.context = context;
    this.canvas = canvas;
    this.settings = settings;
    this.atrousVariant = tiledAtrous ? "tiled-16" : "fallback";
    this.pixelBudget = Math.min(
      GiRenderer.learnedPixelBudget,
      Math.floor(
        device.limits.maxStorageBufferBindingSize / MAX_RESERVOIR_BYTES,
      ),
      Math.floor(device.limits.maxBufferSize / MAX_RESERVOIR_BYTES),
    );
    this.layouts = GiRenderer.createLayouts(device);
    this.pipelines = GiRenderer.createPipelines(
      device,
      this.layouts,
      format,
      tiledAtrous,
    );
    this.atrousWorkgroupSize = tiledAtrous
      ? TILED_ATROUS_WORKGROUP_SIZE
      : WORKGROUP_SIZE;
    this.uniformBuffer = device.createBuffer({
      label: "uniforms",
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.presentUniformBindGroup = createBindGroup(
      device,
      this.layouts.presentUniform,
      [{ buffer: this.uniformBuffer }],
    );
    this.atrousBuffers = Array.from({ length: ATROUS_ITERATIONS }, (_, i) => {
      const buffer = device.createBuffer({
        label: `atrous-step-${String(i)}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, new Int32Array([1 << i, 0, 0, 0]));
      return buffer;
    });

    void device.lost.then(() => {
      this.deviceIsLost = true;
    });

    if (device.features.has("timestamp-query")) {
      this.passProbe = {
        querySet: device.createQuerySet({
          type: "timestamp",
          count: MAX_TIMED_PASSES * 2,
        }),
        slots: Array.from({ length: PROBE_RING_SIZE }, (_, i) => ({
          resolve: device.createBuffer({
            label: `probe-resolve-${String(i)}`,
            size: MAX_TIMED_PASSES * 2 * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
          }),
          staging: device.createBuffer({
            label: `probe-staging-${String(i)}`,
            size: MAX_TIMED_PASSES * 2 * 8,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          busy: false,
        })),
        next: 0,
        labels: [],
        capturing: false,
        samples: [],
      };
    }

    this.comparisonSession = createComparisonSession(
      () => this.captureLinearImage(),
      (durationMs) => this.captureAfterCompletionWindow(durationMs),
      (frames) => this.captureAfterCompletionFrames(frames),
      () => this.getComparisonContext(),
    );
    installDevHooks(() => this.captureLinearImage(), this.comparisonSession);
    this.scene = buildScene(settings.scene);
    const uploaded = this.uploadScene(this.scene);
    this.quadBuffer = uploaded.quadBuffer;
    this.lightBuffer = uploaded.lightBuffer;
    this.clusterBuffer = uploaded.clusterBuffer;
    this.glassShapeBuffer = uploaded.glassShapeBuffer;
    this.sceneBindGroup = uploaded.bindGroup;
  }

  static async create(
    canvas: HTMLCanvasElement,
    settings: RenderSettings,
  ): Promise<GiRenderer> {
    const gpu: GPU | undefined = navigator.gpu;
    if (gpu === undefined) {
      throw new WebGpuUnsupportedError(
        "This browser does not expose the WebGPU API.",
      );
    }
    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (adapter === null) {
      throw new WebGpuUnsupportedError("No suitable GPU adapter was found.");
    }
    const tiledAtrous = selectTiledAtrous(
      adapter.limits,
      window.location.search,
    );
    // Requested up front because a device cannot gain a feature later; the
    // per-pass writes stay off until a capture asks for them.
    const timestamps: GPUFeatureName = "timestamp-query";
    const device = await adapter.requestDevice({
      ...(tiledAtrous
        ? {
            requiredLimits: {
              maxComputeWorkgroupStorageSize: TILED_ATROUS_STORAGE_BYTES,
            },
          }
        : {}),
      ...(adapter.features.has(timestamps)
        ? { requiredFeatures: [timestamps] }
        : {}),
    });
    // Errors outside an error scope are invisible on browsers that don't log
    // them, and a silent GPU error renders as a black canvas.
    device.addEventListener("uncapturederror", (event) => {
      console.error(`[web-gi] uncaptured WebGPU error: ${event.error.message}`);
    });
    const context = canvas.getContext("webgpu");
    if (context === null) {
      throw new WebGpuUnsupportedError(
        "Could not acquire a WebGPU canvas context.",
      );
    }
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    console.info(
      `[web-gi] a-trous: ${tiledAtrous ? "16x16 tiled (24 KiB workgroup storage)" : "8x8 texture fallback"}`,
    );
    return new GiRenderer(
      device,
      context,
      canvas,
      format,
      settings,
      tiledAtrous,
    );
  }

  private static createLayouts(device: GPUDevice): Layouts {
    const compute = GPUShaderStage.COMPUTE;
    const fragment = GPUShaderStage.FRAGMENT;
    return {
      scene: createLayout(device, "scene", compute, [
        uniformBinding,
        readOnlyStorage,
        readOnlyStorage,
        readOnlyStorage,
        readOnlyStorage,
      ]),
      gbuffer: createLayout(device, "gbuffer", compute, [
        storageTexture("r32float"),
        storageTexture("rgba16float"),
        storageTexture("rgba8unorm"),
        storageTexture("rgba16float"),
      ]),
      resample: createLayout(device, "resample", compute, [
        rawTexture,
        floatTexture,
        floatTexture,
        rawTexture,
        floatTexture,
        readOnlyStorage,
        storageBinding,
      ]),
      spatial: createLayout(device, "spatial", compute, [
        rawTexture,
        floatTexture,
        floatTexture,
        readOnlyStorage,
        storageBinding,
      ]),
      shade: createLayout(device, "shade", compute, [
        rawTexture,
        floatTexture,
        readOnlyStorage,
        readOnlyStorage,
        storageTexture("rgba16float"),
      ]),
      pathTrace: createLayout(device, "path-trace", compute, [
        rawTexture,
        floatTexture,
        storageTexture("rgba16float"),
      ]),
      reference: createLayout(device, "reference", compute, [
        rawTexture,
        storageTexture("rgba32float"),
      ]),
      temporal: createLayout(device, "temporal", compute, [
        floatTexture,
        rawTexture,
        floatTexture,
        rawTexture,
        floatTexture,
        rawTexture,
        storageTexture("rgba32float"),
      ]),
      atrous: createLayout(device, "atrous", compute, [
        rawTexture,
        rawTexture,
        floatTexture,
        storageTexture("rgba16float"),
        uniformBinding,
      ]),
      presentUniform: createLayout(device, "present-uniform", fragment, [
        uniformBinding,
      ]),
      presentRestir: createLayout(device, "present-restir", fragment, [
        floatTexture,
        floatTexture,
        floatTexture,
      ]),
      presentReference: createLayout(device, "present-reference", fragment, [
        rawTexture,
      ]),
      capture: createLayout(device, "capture", compute, [
        rawTexture,
        rawTexture,
        rawTexture,
        storageTexture("rgba32float"),
      ]),
    };
  }

  private static createPipelines(
    device: GPUDevice,
    layouts: Layouts,
    format: GPUTextureFormat,
    tiledAtrous: boolean,
  ): Pipelines {
    const traced = (label: string, body: string): GPUShaderModule => {
      const module = device.createShaderModule({
        label,
        code: `${commonWgsl}\n${sceneWgsl}\n${body}`,
      });
      reportShaderDiagnostics(module, label);
      return module;
    };
    const compute = (
      label: string,
      body: string,
      passLayout: GPUBindGroupLayout,
    ): GPUComputePipeline =>
      device.createComputePipeline({
        label,
        layout: device.createPipelineLayout({
          bindGroupLayouts: [layouts.scene, passLayout],
        }),
        compute: { module: traced(label, body), entryPoint: "main" },
      });

    const presentModule = device.createShaderModule({
      label: "present",
      code: `${commonWgsl}\n${presentWgsl}`,
    });
    reportShaderDiagnostics(presentModule, "present");
    const present = (
      label: string,
      entryPoint: string,
      passLayout: GPUBindGroupLayout,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({
          bindGroupLayouts: [layouts.presentUniform, passLayout],
        }),
        vertex: { module: presentModule, entryPoint: "vs" },
        fragment: {
          module: presentModule,
          entryPoint,
          targets: [{ format }],
        },
        primitive: { topology: "triangle-list" },
      });

    return assembleRendererPipelines(layouts, tiledAtrous, compute, present);
  }

  private uploadScene(scene: Scene): {
    quadBuffer: GPUBuffer;
    lightBuffer: GPUBuffer;
    clusterBuffer: GPUBuffer;
    glassShapeBuffer: GPUBuffer;
    bindGroup: GPUBindGroup;
  } {
    const quadData = packQuads(scene);
    const lightData = packLights(scene);
    const quadBuffer = this.device.createBuffer({
      label: "quads",
      size: Math.max(quadData.byteLength, QUAD_STRIDE_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const lightBuffer = this.device.createBuffer({
      label: "lights",
      size: Math.max(lightData.byteLength, LIGHT_STRIDE_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const clusterData = packClusters(scene);
    const clusterBuffer = this.device.createBuffer({
      label: "occluder-clusters",
      size: Math.max(clusterData.byteLength, CLUSTER_STRIDE_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const glassShapeData = packGlassShapes(scene);
    const glassShapeBuffer = this.device.createBuffer({
      label: "glass-shapes",
      size: Math.max(glassShapeData.byteLength, GLASS_SHAPE_STRIDE_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(quadBuffer, 0, quadData);
    this.device.queue.writeBuffer(lightBuffer, 0, lightData);
    this.device.queue.writeBuffer(clusterBuffer, 0, clusterData);
    this.device.queue.writeBuffer(glassShapeBuffer, 0, glassShapeData);
    const bindGroup = createBindGroup(this.device, this.layouts.scene, [
      { buffer: this.uniformBuffer },
      { buffer: quadBuffer },
      { buffer: lightBuffer },
      { buffer: clusterBuffer },
      { buffer: glassShapeBuffer },
    ]);
    return {
      quadBuffer,
      lightBuffer,
      clusterBuffer,
      glassShapeBuffer,
      bindGroup,
    };
  }

  setSettings(next: RenderSettings): void {
    const previous = this.settings;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.comparisonGeneration += 1;
      this.abortComparison("Render settings changed during the comparison.");
    }
    this.settings = next;
    if (previous.scene !== next.scene) {
      this.quadBuffer.destroy();
      this.lightBuffer.destroy();
      this.clusterBuffer.destroy();
      this.glassShapeBuffer.destroy();
      this.scene = buildScene(next.scene);
      const uploaded = this.uploadScene(this.scene);
      this.quadBuffer = uploaded.quadBuffer;
      this.lightBuffer = uploaded.lightBuffer;
      this.clusterBuffer = uploaded.clusterBuffer;
      this.glassShapeBuffer = uploaded.glassShapeBuffer;
      this.sceneBindGroup = uploaded.bindGroup;
    }
    if (requiresAccumulationReset(previous, next)) {
      this.resetAccumulation();
    }
  }

  /** Diffuse irradiance is view-independent; glass and reference radiance are not. */
  notifyCameraChanged(): void {
    this.comparisonGeneration += 1;
    this.abortComparison("The camera moved during the comparison.");
    if (
      this.settings.mode === "reference" ||
      this.scene.glassShapes.length > 0
    ) {
      this.resetAccumulation();
    }
  }

  resetAccumulation(): void {
    this.accumFrames = 0;
  }

  get deviceLost(): Promise<DeviceLossInfo> {
    return this.device.lost;
  }

  /** Non-null once the targets cannot be allocated at any usable size. */
  get allocationError(): string | null {
    return this.allocationFailure;
  }

  get stats(): RendererStats {
    return {
      width: this.targets?.width ?? 0,
      height: this.targets?.height ?? 0,
      accumFrames: this.accumFrames,
      frameMs: this.lastFrameMs,
      atrousVariant: this.atrousVariant,
    };
  }

  saveComparisonReference(): Promise<boolean> {
    return this.comparisonSession.saveReference();
  }

  saveComparisonReferenceAfterFrames(frames: number): Promise<boolean> {
    return this.comparisonSession.saveReferenceAfterFrames(frames);
  }

  compareReferenceAfter(
    label: string,
    durationMs: number,
  ): Promise<LinearComparisonReport | null> {
    return this.comparisonSession.compareReferenceAfter(label, durationMs);
  }

  releaseComparisonResources(): void {
    this.comparisonSession.clearReference();
    this.releaseCapture();
  }

  cancelComparison(message = "The comparison was cancelled."): void {
    this.comparisonGeneration += 1;
    this.abortComparison(message);
  }

  private resolveSize(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    return resolveRenderSize({
      cssWidth: rect.width,
      cssHeight: rect.height,
      resolutionScale: this.settings.resolutionScale,
      devicePixelRatio: window.devicePixelRatio,
      maxDimension: Math.min(
        this.device.limits.maxTextureDimension2D,
        this.device.limits.maxComputeWorkgroupsPerDimension * WORKGROUP_SIZE,
      ),
      maxPixels: this.pixelBudget,
    });
  }

  private createTargets(width: number, height: number): Targets {
    const device = this.device;
    const pixels = width * height;
    const texture = (
      label: string,
      format: GPUTextureFormat,
      count: number,
    ): GPUTexture[] =>
      Array.from({ length: count }, (_, i) =>
        device.createTexture({
          label: `${label}-${String(i)}`,
          size: { width, height },
          format,
          usage:
            GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );

    // View-space depth, not a world position: the fourth channel only ever
    // carried a hit flag, and this is the most-read target in the pipeline.
    const depth = texture("depth", "r32float", 2);
    const normal = texture("normal", "rgba16float", 2);
    const albedo = texture("albedo", "rgba8unorm", 1);
    const emission = texture("emission", "rgba16float", 1);
    const illumination = texture("illumination", "rgba16float", 1);
    // f32 because the accumulator is a running mean: at a long history length
    // the per-frame increment falls under half precision's resolution and the
    // average stalls below the converged value. rgba32float is unfilterable, so
    // every layout entry that samples this texture binds it as `rawTexture`.
    const history = texture("history", "rgba32float", 2);
    const atrous = texture("atrous", "rgba16float", 2);
    const reference = texture("reference", "rgba32float", 2);

    const storage = (label: string, stride: number): GPUBuffer =>
      device.createBuffer({
        label,
        size: pixels * stride,
        usage: GPUBufferUsage.STORAGE,
      });
    const diScratch = storage("di-scratch", DI_RESERVOIR_BYTES);
    const diFinal = [
      storage("di-final-0", DI_RESERVOIR_BYTES),
      storage("di-final-1", DI_RESERVOIR_BYTES),
    ];
    const giScratch = storage("gi-scratch", GI_RESERVOIR_BYTES);
    const giFinal = [
      storage("gi-final-0", GI_RESERVOIR_BYTES),
      storage("gi-final-1", GI_RESERVOIR_BYTES),
    ];

    const view = (t: GPUTexture): GPUTextureView => t.createView();
    const parities = [0, 1];

    return {
      width,
      height,
      textures: [
        ...depth,
        ...normal,
        ...albedo,
        ...emission,
        ...illumination,
        ...history,
        ...atrous,
        ...reference,
      ],
      buffers: [diScratch, ...diFinal, giScratch, ...giFinal],
      gbuffer: parities.map((p) =>
        createBindGroup(device, this.layouts.gbuffer, [
          view(at(depth, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          view(at(emission, 0)),
        ]),
      ),
      di: parities.map((p) =>
        createBindGroup(device, this.layouts.resample, [
          view(at(depth, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          view(at(depth, 1 - p)),
          view(at(normal, 1 - p)),
          { buffer: at(diFinal, 1 - p) },
          { buffer: diScratch },
        ]),
      ),
      diSpatial: parities.map((p) =>
        createBindGroup(device, this.layouts.spatial, [
          view(at(depth, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          { buffer: diScratch },
          { buffer: at(diFinal, p) },
        ]),
      ),
      gi: parities.map((p) =>
        createBindGroup(device, this.layouts.resample, [
          view(at(depth, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          view(at(depth, 1 - p)),
          view(at(normal, 1 - p)),
          { buffer: at(giFinal, 1 - p) },
          { buffer: giScratch },
        ]),
      ),
      giSpatial: parities.map((p) =>
        createBindGroup(device, this.layouts.spatial, [
          view(at(depth, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          { buffer: giScratch },
          { buffer: at(giFinal, p) },
        ]),
      ),
      shade: parities.map((p) =>
        createBindGroup(device, this.layouts.shade, [
          view(at(depth, p)),
          view(at(normal, p)),
          { buffer: at(diFinal, p) },
          { buffer: at(giFinal, p) },
          view(at(illumination, 0)),
        ]),
      ),
      pathTrace: parities.map((p) =>
        createBindGroup(device, this.layouts.pathTrace, [
          view(at(depth, p)),
          view(at(normal, p)),
          view(at(illumination, 0)),
        ]),
      ),
      reference: parities.map((p) =>
        createBindGroup(device, this.layouts.reference, [
          view(at(reference, 1 - p)),
          view(at(reference, p)),
        ]),
      ),
      temporal: parities.map((p) =>
        createBindGroup(device, this.layouts.temporal, [
          view(at(illumination, 0)),
          view(at(depth, p)),
          view(at(normal, p)),
          view(at(depth, 1 - p)),
          view(at(normal, 1 - p)),
          view(at(history, 1 - p)),
          view(at(history, p)),
        ]),
      ),
      // Iteration 0 filters the accumulated history; the chain then ping-pongs
      // and lands back on atrous[0], which the present pass samples.
      atrous: parities.map((p) => {
        const chain: readonly (readonly [GPUTexture, GPUTexture])[] = [
          [at(history, p), at(atrous, 0)],
          [at(atrous, 0), at(atrous, 1)],
          [at(atrous, 1), at(atrous, 0)],
        ];
        return chain.map(([source, destination], iteration) =>
          createBindGroup(device, this.layouts.atrous, [
            view(source),
            view(at(depth, p)),
            view(at(normal, p)),
            view(destination),
            { buffer: at(this.atrousBuffers, iteration) },
          ]),
        );
      }),
      presentRestir: createBindGroup(device, this.layouts.presentRestir, [
        view(at(atrous, 0)),
        view(at(albedo, 0)),
        view(at(emission, 0)),
      ]),
      presentReference: parities.map((p) =>
        createBindGroup(device, this.layouts.presentReference, [
          view(at(reference, p)),
        ]),
      ),
      atrousView: view(at(atrous, 0)),
      albedoView: view(at(albedo, 0)),
      emissionView: view(at(emission, 0)),
      referenceViews: parities.map((p) => view(at(reference, p))),
    };
  }

  private releaseTargets(): void {
    const current = this.targets;
    if (current === null) return;
    this.releaseCapture();
    this.targets = null;
    for (const t of current.textures) t.destroy();
    for (const b of current.buffers) b.destroy();
  }

  private ensureTargets(): Targets {
    const { width, height } = this.resolveSize();
    const current = this.targets;
    if (
      current !== null &&
      current.width === width &&
      current.height === height
    ) {
      return current;
    }
    this.releaseTargets();
    this.canvas.width = width;
    this.canvas.height = height;
    this.device.pushErrorScope("out-of-memory");
    this.device.pushErrorScope("validation");
    const targets = this.createTargets(width, height);
    this.targets = targets;
    this.comparisonGeneration += 1;
    this.resetAccumulation();
    void this.watchAllocation(width * height);
    return targets;
  }

  /**
   * A failed allocation is reported asynchronously and yields objects that are
   * merely invalid, so every compute pass silently no-ops and the canvas stays
   * black. Halving the budget and rebuilding is the only way back.
   */
  private async watchAllocation(pixels: number): Promise<void> {
    // Both scopes are popped before the first await: awaiting between them lets
    // a concurrent rebuild's push land in the middle and hand this call the
    // other generation's error. LIFO — validation was pushed last.
    const validation = this.device.popErrorScope();
    const outOfMemory = this.device.popErrorScope();
    let error: GPUError | null;
    try {
      error = (await validation) ?? (await outOfMemory);
    } catch (reason) {
      // Device loss is expected here and already reported through `deviceLost`;
      // anything else would otherwise disable the back-off with no trace.
      if (!this.destroyed && !this.deviceIsLost) {
        console.error(`[web-gi] error scope failed: ${String(reason)}`);
      }
      return;
    }
    if (error === null || this.destroyed) return;

    // Clamped, not compared: halving from just above the floor would otherwise
    // skip the floor itself and give up on a budget that may well have worked.
    const next = Math.max(MIN_PIXEL_BUDGET, Math.floor(pixels / 2));
    if (next >= pixels) {
      this.releaseTargets();
      this.allocationFailure = `The GPU could not allocate the render targets: ${error.message}`;
      return;
    }
    console.warn(
      `[web-gi] render targets failed at ${String(pixels)} px, retrying at ${String(next)} px: ${error.message}`,
    );
    GiRenderer.learnedPixelBudget = Math.min(
      GiRenderer.learnedPixelBudget,
      next,
    );
    this.pixelBudget = next;
    this.releaseTargets();
  }

  private writeUniforms(basis: CameraBasis, targets: Targets): void {
    const view = new DataView(this.uniformData);
    writeCamera(view, 0, basis);
    writeCamera(view, 64, this.previousBasis ?? basis);
    view.setUint32(128, targets.width, true);
    view.setUint32(132, targets.height, true);
    view.setUint32(136, this.frame, true);
    view.setUint32(140, this.accumFrames, true);
    view.setUint32(144, this.scene.quads.length, true);
    view.setUint32(148, this.scene.lights.length, true);
    view.setUint32(152, this.settings.diCandidates, true);
    view.setUint32(156, this.settings.spatialSamples, true);
    view.setUint32(160, this.settings.maxBounces, true);
    view.setUint32(164, this.settings.maxHistory, true);
    view.setUint32(168, packFlags(this.settings), true);
    view.setFloat32(172, this.settings.spatialRadius, true);
    view.setFloat32(176, this.settings.exposure, true);
    view.setUint32(180, this.scene.clusters.length, true);
    view.setUint32(184, this.scene.occluderClusterCount, true);
    view.setUint32(188, this.scene.glassShapes.length, true);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  renderFrame(camera: OrbitCamera): void {
    if (this.lastCamera !== null && !camerasEqual(this.lastCamera, camera)) {
      this.comparisonGeneration += 1;
      this.abortComparison("The camera moved during the comparison.");
    }
    this.lastCamera = camera;
    if (this.comparisonInProgress) return;
    this.renderFrameNow(camera);
  }

  private renderFrameNow(
    camera: OrbitCamera,
    output: "present" | "headless" = "present",
  ): void {
    if (this.destroyed || this.allocationFailure !== null) return;
    // Wall-clock interval between submissions. requestAnimationFrame paces the
    // loop, so this reports the real (vsync- or GPU-bound) frame time rather
    // than the negligible command-encoding cost.
    const started = performance.now();
    if (output === "present") {
      this.lastFrameMs = this.lastFrameAt > 0 ? started - this.lastFrameAt : 0;
    }
    this.lastFrameAt = started;
    const targets = this.ensureTargets();
    const basis = cameraBasis(camera, targets.width / targets.height);
    this.writeUniforms(basis, targets);

    const parity = this.parity;
    const encoder = this.device.createCommandEncoder();
    const probe = this.passProbe;
    const timing = probe !== null && probe.capturing;
    if (timing && probe !== null) probe.labels.length = 0;

    /** Timestamp bracket for the next pass, or nothing when not capturing. */
    const timestampWrites = (
      label: string,
    ): { timestampWrites: GPUComputePassTimestampWrites } | undefined => {
      if (
        !timing ||
        probe === null ||
        probe.labels.length >= MAX_TIMED_PASSES
      ) {
        return undefined;
      }
      const slot = probe.labels.length;
      probe.labels.push(label);
      return {
        timestampWrites: {
          querySet: probe.querySet,
          beginningOfPassWriteIndex: slot * 2,
          endOfPassWriteIndex: slot * 2 + 1,
        },
      };
    };

    // A compute pass's usage scope is the single dispatch, so merging the chain
    // into one pass is legal. Timestamps bracket a pass, so a capture restores
    // the boundaries and therefore never measures the shipped structure.
    const sharedPass = timing ? null : encoder.beginComputePass();
    const dispatch = (
      pipeline: GPUComputePipeline,
      passBindGroup: GPUBindGroup,
      label: string,
      workgroupSize = WORKGROUP_SIZE,
    ): void => {
      const pass =
        sharedPass ?? encoder.beginComputePass(timestampWrites(label));
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.sceneBindGroup);
      pass.setBindGroup(1, passBindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(targets.width / workgroupSize),
        Math.ceil(targets.height / workgroupSize),
      );
      if (sharedPass === null) pass.end();
    };

    const reference = this.settings.mode === "reference";
    if (reference) {
      dispatch(
        this.pipelines.reference,
        at(targets.reference, parity),
        "reference",
      );
    } else {
      dispatch(this.pipelines.gbuffer, at(targets.gbuffer, parity), "gbuffer");
      if (this.settings.mode === "path-traced") {
        dispatch(
          this.pipelines.getPathTracePipeline(),
          at(targets.pathTrace, parity),
          "pathTrace",
        );
      } else {
        dispatch(this.pipelines.di, at(targets.di, parity), "di");
        dispatch(
          this.pipelines.diSpatial,
          at(targets.diSpatial, parity),
          "diSpatial",
        );
        dispatch(this.pipelines.gi, at(targets.gi, parity), "gi");
        dispatch(
          this.pipelines.giSpatial,
          at(targets.giSpatial, parity),
          "giSpatial",
        );
        dispatch(this.pipelines.shade, at(targets.shade, parity), "shade");
      }
      dispatch(
        this.pipelines.temporal,
        at(targets.temporal, parity),
        "temporal",
      );
      const chain = at(targets.atrous, parity);
      for (let i = 0; i < ATROUS_ITERATIONS; i++) {
        dispatch(
          this.pipelines.atrous,
          at(chain, i),
          `atrous${String(i)}`,
          this.atrousWorkgroupSize,
        );
      }
    }
    sharedPass?.end();

    if (output === "present") {
      // Timed too: without it the per-pass total is not the frame's GPU time.
      const presentTimestamps = timestampWrites("present");
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        ...(presentTimestamps === undefined
          ? {}
          : { timestampWrites: presentTimestamps.timestampWrites }),
      });
      renderPass.setPipeline(
        reference
          ? this.pipelines.presentReference
          : this.pipelines.presentRestir,
      );
      renderPass.setBindGroup(0, this.presentUniformBindGroup);
      renderPass.setBindGroup(
        1,
        reference
          ? at(targets.presentReference, parity)
          : targets.presentRestir,
      );
      renderPass.draw(3);
      renderPass.end();
    }

    const slot =
      timing && probe !== null && probe.labels.length > 0
        ? probe.slots[probe.next]
        : undefined;
    // A full ring means the GPU is further behind than the ring is deep; skip
    // this frame's timings rather than stall waiting for a slot.
    const sampling = slot !== undefined && !slot.busy;
    const labels = sampling && probe !== null ? [...probe.labels] : [];
    if (sampling && slot !== undefined && probe !== null) {
      const count = labels.length * 2;
      slot.busy = true;
      probe.next = (probe.next + 1) % probe.slots.length;
      encoder.resolveQuerySet(probe.querySet, 0, count, slot.resolve, 0);
      encoder.copyBufferToBuffer(slot.resolve, 0, slot.staging, 0, count * 8);
    }

    this.device.queue.submit([encoder.finish()]);

    if (sampling && slot !== undefined && probe !== null) {
      void slot.staging
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const times = new BigUint64Array(
            slot.staging.getMappedRange().slice(0),
          );
          slot.staging.unmap();
          const passMs: Record<string, number> = {};
          let begin: bigint | null = null;
          let end: bigint | null = null;
          labels.forEach((label, i) => {
            const from = times[i * 2];
            const to = times[i * 2 + 1];
            if (from === undefined || to === undefined) return;
            passMs[label] = (passMs[label] ?? 0) + Number(to - from) / 1e6;
            if (begin === null || from < begin) begin = from;
            if (end === null || to > end) end = to;
          });
          // Spans the frame's first pass to its last, so it is an elapsed
          // duration rather than a sum of per-pass medians.
          if (begin !== null && end !== null) {
            probe.samples.push({
              frameMs: Number(end - begin) / 1e6,
              passMs,
            });
          }
        })
        .catch(() => {
          // Device lost or buffer destroyed mid-flight; drop the sample.
        })
        .finally(() => {
          slot.busy = false;
        });
    }

    this.previousBasis = basis;
    this.parity = 1 - parity;
    this.frame += 1;
    this.accumFrames += 1;
  }

  /**
   * Runs one submitted frame at a time so the comparison window measures work
   * the GPU has completed, independent of display refresh rate and queue depth.
   */
  private abortComparison(message: string): void {
    this.comparisonAbortController?.abort(new Error(message));
  }

  private beginComparison(): AbortController {
    if (this.comparisonInProgress) {
      throw new Error("A comparison is already running.");
    }
    const controller = new AbortController();
    this.comparisonInProgress = true;
    this.comparisonAbortController = controller;
    return controller;
  }

  private endComparison(controller: AbortController): void {
    if (this.comparisonAbortController === controller) {
      this.comparisonAbortController = null;
      this.comparisonInProgress = false;
    }
  }

  private waitForComparisonOperation<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    deadline: number,
    failureMessage: string,
  ): Promise<T> {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      return Promise.reject(new Error("The comparison timed out."));
    }
    if (signal.aborted) {
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("The comparison was cancelled."),
      );
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = (): boolean => {
        if (settled) return false;
        settled = true;
        window.clearTimeout(timeoutId);
        signal.removeEventListener("abort", onAbort);
        return true;
      };
      const fail = (error: unknown): void => {
        if (!cleanup()) return;
        reject(error instanceof Error ? error : new Error(failureMessage));
      };
      const onAbort = (): void => {
        fail(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("The comparison was cancelled."),
        );
      };
      const timeoutId = window.setTimeout(() => {
        fail(new Error("The comparison timed out."));
      }, remainingMs);
      signal.addEventListener("abort", onAbort, { once: true });
      void operation.then(
        (value) => {
          if (!cleanup()) return;
          resolve(value);
        },
        (error: unknown) => fail(error),
      );
    });
  }

  private waitForSubmittedWork(
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    return this.waitForComparisonOperation(
      this.device.queue.onSubmittedWorkDone(),
      signal,
      deadline,
      "GPU completion failed during the comparison.",
    );
  }

  private async captureAfterCompletionWindow(
    durationMs: number,
  ): Promise<CompletionWindowCapture | null> {
    const camera = this.lastCamera;
    if (
      camera === null ||
      this.destroyed ||
      this.deviceIsLost ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    ) {
      return null;
    }
    const controller = this.beginComparison();
    const generation = this.comparisonGeneration;
    const deadline =
      performance.now() + durationMs + COMPLETION_WINDOW_TIMEOUT_PADDING_MS;
    try {
      await this.waitForSubmittedWork(controller.signal, deadline);
      this.resetAccumulation();
      const started = performance.now();
      do {
        this.renderFrameNow(camera);
        await this.waitForSubmittedWork(controller.signal, deadline);
        if (this.comparisonGeneration !== generation) {
          throw new Error(
            "Render configuration changed during the comparison.",
          );
        }
      } while (performance.now() - started < durationMs);
      const actualDurationMs = performance.now() - started;
      const frames = this.accumFrames;
      const image = await this.waitForComparisonOperation(
        this.captureLinearImage(),
        controller.signal,
        deadline,
        "Linear readback failed during the comparison.",
      );
      if (this.comparisonGeneration !== generation) {
        throw new Error("Render configuration changed during the comparison.");
      }
      return image === null ? null : { image, actualDurationMs, frames };
    } finally {
      this.endComparison(controller);
    }
  }

  /** Builds an exact-size oracle without display-refresh pacing. */
  private async captureAfterCompletionFrames(
    requestedFrames: number,
  ): Promise<CompletionWindowCapture | null> {
    const camera = this.lastCamera;
    if (
      camera === null ||
      this.destroyed ||
      this.deviceIsLost ||
      !Number.isInteger(requestedFrames) ||
      requestedFrames <= 0
    ) {
      return null;
    }
    const controller = this.beginComparison();
    const generation = this.comparisonGeneration;
    const deadline = performance.now() + REFERENCE_CAPTURE_TIMEOUT_MS;
    try {
      await this.waitForSubmittedWork(controller.signal, deadline);
      this.resetAccumulation();
      const started = performance.now();
      const completed = await runCompletionBatches(
        requestedFrames,
        REFERENCE_COMPLETION_BATCH_SIZE,
        {
          getFrameCount: () => this.accumFrames,
          renderFrame: () => this.renderFrameNow(camera, "headless"),
          waitForSubmittedWork: () =>
            this.waitForSubmittedWork(controller.signal, deadline),
          validateAfterWait: () => {
            if (this.comparisonGeneration !== generation) {
              throw new Error(
                "Render configuration changed during the comparison.",
              );
            }
          },
        },
      );
      if (!completed) return null;
      const actualDurationMs = performance.now() - started;
      const image = await this.waitForComparisonOperation(
        this.captureLinearImage(),
        controller.signal,
        deadline,
        "Linear readback failed during the comparison.",
      );
      if (this.comparisonGeneration !== generation) {
        throw new Error("Render configuration changed during the comparison.");
      }
      return image === null
        ? null
        : { image, actualDurationMs, frames: this.accumFrames };
    } finally {
      this.endComparison(controller);
    }
  }

  private getComparisonContext(): ComparisonContext | null {
    const targets = this.targets;
    const camera = this.lastCamera;
    if (targets === null || camera === null) return null;
    const basis = cameraBasis(camera, targets.width / targets.height);
    const referenceDetails = {
      atrousVariant: this.atrousVariant,
      scene: this.settings.scene,
      maxBounces: this.settings.maxBounces,
      width: targets.width,
      height: targets.height,
      camera: basis,
    };
    const referenceKey = JSON.stringify(referenceDetails);
    return {
      mode: this.settings.mode,
      referenceKey,
      runKey: JSON.stringify({
        referenceKey,
        settings: this.settings,
        generation: this.comparisonGeneration,
      }),
      accumFrames: this.accumFrames,
      details: { ...referenceDetails, settings: { ...this.settings } },
    };
  }

  /** True when this device can time passes at all. */
  get supportsGpuTiming(): boolean {
    return this.passProbe !== null;
  }

  /**
   * Per-pass timestamp writes are off outside a capture: they can inhibit
   * driver-level pass merging, so leaving them on would measure a renderer the
   * user never runs.
   */
  setGpuTimingEnabled(enabled: boolean): void {
    const probe = this.passProbe;
    if (probe === null) return;
    probe.capturing = enabled;
    if (!enabled) probe.samples.length = 0;
  }

  /** Drains the frames sampled since the last call. */
  takeGpuSamples(): GpuFrameSample[] {
    const probe = this.passProbe;
    if (probe === null) return [];
    return probe.samples.splice(0, probe.samples.length);
  }

  /**
   * The linear radiance behind the current frame, before tone mapping — what
   * `compareLinear` needs to check the render against the reference path
   * tracer. Resources are built on first use and released with the targets, so
   * a session that never measures pays nothing for this.
   *
   * Returns null when there is nothing to read yet. The caller drives
   * convergence: switch mode, wait, then capture.
   */
  async captureLinearImage(): Promise<LinearImage | null> {
    if (this.captureInProgress) {
      throw new Error("A linear capture is already running.");
    }
    this.captureInProgress = true;
    try {
      return await this.captureLinearImageNow();
    } finally {
      this.captureInProgress = false;
    }
  }

  private async captureLinearImageNow(): Promise<LinearImage | null> {
    const targets = this.targets;
    if (
      this.destroyed ||
      targets === null ||
      this.deviceIsLost ||
      this.accumFrames === 0
    ) {
      return null;
    }

    const capture = this.ensureCapture(targets);
    const pipelines = this.ensureCapturePipelines();
    const encoder = this.device.createCommandEncoder({ label: "capture" });
    const reference = this.settings.mode === "reference";
    const pass = encoder.beginComputePass();
    pass.setPipeline(reference ? pipelines.reference : pipelines.denoised);
    pass.setBindGroup(0, this.sceneBindGroup);
    pass.setBindGroup(
      1,
      reference ? at(capture.reference, 1 - this.parity) : capture.denoised,
    );
    pass.dispatchWorkgroups(
      Math.ceil(targets.width / WORKGROUP_SIZE),
      Math.ceil(targets.height / WORKGROUP_SIZE),
    );
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: capture.texture },
      { buffer: capture.staging, bytesPerRow: capture.bytesPerRow },
      { width: targets.width, height: targets.height },
    );
    this.device.queue.submit([encoder.finish()]);

    await capture.staging.mapAsync(GPUMapMode.READ);
    // The copy pads each row to the 256-byte pitch, so the rows are gathered
    // rather than taken as one run.
    const padded = new Float32Array(capture.staging.getMappedRange());
    const stride = capture.bytesPerRow / 4;
    const data = new Float32Array(targets.width * targets.height * 4);
    for (let row = 0; row < targets.height; row++) {
      data.set(
        padded.subarray(row * stride, row * stride + targets.width * 4),
        row * targets.width * 4,
      );
    }
    capture.staging.unmap();
    return { width: targets.width, height: targets.height, data };
  }

  /**
   * Built on demand so normal rendering never compiles the measurement-only
   * capture shader.
   */
  private ensureCapturePipelines(): CapturePipelines {
    const existing = this.capturePipelines;
    if (existing !== null) return existing;
    const module = this.device.createShaderModule({
      label: "capture",
      code: `${commonWgsl}\n${sceneWgsl}\n${captureWgsl}`,
    });
    reportShaderDiagnostics(module, "capture");
    const build = (entryPoint: string): GPUComputePipeline =>
      this.device.createComputePipeline({
        label: `capture-${entryPoint}`,
        layout: this.device.createPipelineLayout({
          bindGroupLayouts: [this.layouts.scene, this.layouts.capture],
        }),
        compute: { module, entryPoint },
      });
    const created = {
      denoised: build("denoised"),
      reference: build("reference"),
    };
    this.capturePipelines = created;
    return created;
  }

  private ensureCapture(targets: Targets): CaptureResources {
    const existing = this.capture;
    if (
      existing !== null &&
      existing.width === targets.width &&
      existing.height === targets.height
    ) {
      return existing;
    }
    this.releaseCapture();

    const bytesPerRow =
      Math.ceil((targets.width * 16) / COPY_ALIGNMENT) * COPY_ALIGNMENT;
    const texture = this.device.createTexture({
      label: "capture-linear",
      size: { width: targets.width, height: targets.height },
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const staging = this.device.createBuffer({
      label: "capture-staging",
      size: bytesPerRow * targets.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const view = texture.createView();
    // The reference entry point reads only binding 0; the albedo and emission
    // slots remain bound solely to satisfy the shared layout.
    const created: CaptureResources = {
      width: targets.width,
      height: targets.height,
      bytesPerRow,
      texture,
      staging,
      denoised: createBindGroup(this.device, this.layouts.capture, [
        targets.atrousView,
        targets.albedoView,
        targets.emissionView,
        view,
      ]),
      reference: targets.referenceViews.map((referenceColour) =>
        createBindGroup(this.device, this.layouts.capture, [
          referenceColour,
          targets.albedoView,
          targets.emissionView,
          view,
        ]),
      ),
    };
    this.capture = created;
    return created;
  }

  private releaseCapture(): void {
    const current = this.capture;
    if (current === null) return;
    this.capture = null;
    current.texture.destroy();
    current.staging.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelComparison("The renderer stopped during the comparison.");
    this.destroyed = true;
    this.releaseTargets();
    this.quadBuffer.destroy();
    this.lightBuffer.destroy();
    this.clusterBuffer.destroy();
    this.glassShapeBuffer.destroy();
    this.uniformBuffer.destroy();
    for (const buffer of this.atrousBuffers) buffer.destroy();
    if (this.passProbe !== null) {
      this.passProbe.querySet.destroy();
      for (const slot of this.passProbe.slots) {
        slot.resolve.destroy();
        slot.staging.destroy();
      }
    }
    this.device.destroy();
  }
}
