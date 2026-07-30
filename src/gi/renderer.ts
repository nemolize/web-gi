import type { CameraBasis, OrbitCamera } from "@/gi/camera";
import { cameraBasis } from "@/gi/camera";
import type { Scene } from "@/gi/scene";
import {
  buildScene,
  LIGHT_STRIDE_BYTES,
  packLights,
  packQuads,
  QUAD_STRIDE_BYTES,
} from "@/gi/scene";
import type { RenderSettings } from "@/gi/settings";
import { packFlags, requiresAccumulationReset } from "@/gi/settings";
import commonWgsl from "@/gi/shaders/common.wgsl?raw";
import atrousWgsl from "@/gi/shaders/denoise-atrous.wgsl?raw";
import temporalWgsl from "@/gi/shaders/denoise-temporal.wgsl?raw";
import gbufferWgsl from "@/gi/shaders/gbuffer.wgsl?raw";
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
};

const WORKGROUP_SIZE = 8;
const UNIFORM_BYTES = 192;
const DI_RESERVOIR_BYTES = 32;
const GI_RESERVOIR_BYTES = 48;
const ATROUS_ITERATIONS = 3;
/** Keeps the reservoir buffers well inside the default storage-binding limit. */
const MAX_PIXELS = 1_000_000;

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
  readonly reference: GPUBindGroupLayout;
  readonly temporal: GPUBindGroupLayout;
  readonly atrous: GPUBindGroupLayout;
  readonly presentUniform: GPUBindGroupLayout;
  readonly presentRestir: GPUBindGroupLayout;
  readonly presentReference: GPUBindGroupLayout;
};

type Pipelines = {
  readonly gbuffer: GPUComputePipeline;
  readonly di: GPUComputePipeline;
  readonly diSpatial: GPUComputePipeline;
  readonly gi: GPUComputePipeline;
  readonly giSpatial: GPUComputePipeline;
  readonly shade: GPUComputePipeline;
  readonly reference: GPUComputePipeline;
  readonly temporal: GPUComputePipeline;
  readonly atrous: GPUComputePipeline;
  readonly presentRestir: GPURenderPipeline;
  readonly presentReference: GPURenderPipeline;
};

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
  readonly reference: readonly GPUBindGroup[];
  readonly temporal: readonly GPUBindGroup[];
  readonly atrous: readonly (readonly GPUBindGroup[])[];
  readonly presentRestir: GPUBindGroup;
  readonly presentReference: readonly GPUBindGroup[];
};

const at = <T>(items: readonly T[], index: number): T => {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`Missing resource at index ${String(index)}`);
  }
  return value;
};

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
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly layouts: Layouts;
  private readonly pipelines: Pipelines;
  private readonly uniformBuffer: GPUBuffer;
  private readonly presentUniformBindGroup: GPUBindGroup;
  private readonly atrousBuffers: readonly GPUBuffer[];
  private readonly uniformData = new ArrayBuffer(UNIFORM_BYTES);

  private quadBuffer: GPUBuffer;
  private lightBuffer: GPUBuffer;
  private sceneBindGroup: GPUBindGroup;
  private scene: Scene;
  private targets: Targets | null = null;

  private settings: RenderSettings;
  private frame = 0;
  private accumFrames = 0;
  private parity = 0;
  private previousBasis: CameraBasis | null = null;
  private lastFrameAt = 0;
  private lastFrameMs = 0;
  private destroyed = false;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    canvas: HTMLCanvasElement,
    format: GPUTextureFormat,
    settings: RenderSettings,
  ) {
    this.device = device;
    this.context = context;
    this.canvas = canvas;
    this.settings = settings;
    this.layouts = GiRenderer.createLayouts(device);
    this.pipelines = GiRenderer.createPipelines(device, this.layouts, format);
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

    this.scene = buildScene(settings.scene);
    const uploaded = this.uploadScene(this.scene);
    this.quadBuffer = uploaded.quadBuffer;
    this.lightBuffer = uploaded.lightBuffer;
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
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (context === null) {
      throw new WebGpuUnsupportedError(
        "Could not acquire a WebGPU canvas context.",
      );
    }
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    return new GiRenderer(device, context, canvas, format, settings);
  }

  private static createLayouts(device: GPUDevice): Layouts {
    const compute = GPUShaderStage.COMPUTE;
    const fragment = GPUShaderStage.FRAGMENT;
    return {
      scene: createLayout(device, "scene", compute, [
        uniformBinding,
        readOnlyStorage,
        readOnlyStorage,
      ]),
      gbuffer: createLayout(device, "gbuffer", compute, [
        storageTexture("rgba32float"),
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
        floatTexture,
        storageTexture("rgba16float"),
      ]),
      atrous: createLayout(device, "atrous", compute, [
        floatTexture,
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
    };
  }

  private static createPipelines(
    device: GPUDevice,
    layouts: Layouts,
    format: GPUTextureFormat,
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

    return {
      gbuffer: compute("gbuffer", gbufferWgsl, layouts.gbuffer),
      di: compute("restir-di", diWgsl, layouts.resample),
      diSpatial: compute("restir-di-spatial", diSpatialWgsl, layouts.spatial),
      gi: compute("restir-gi", giWgsl, layouts.resample),
      giSpatial: compute("restir-gi-spatial", giSpatialWgsl, layouts.spatial),
      shade: compute("shade", shadeWgsl, layouts.shade),
      reference: compute("reference", referenceWgsl, layouts.reference),
      temporal: compute("denoise-temporal", temporalWgsl, layouts.temporal),
      atrous: compute("denoise-atrous", atrousWgsl, layouts.atrous),
      presentRestir: present("present", "fsRestir", layouts.presentRestir),
      presentReference: present(
        "present-reference",
        "fsReference",
        layouts.presentReference,
      ),
    };
  }

  private uploadScene(scene: Scene): {
    quadBuffer: GPUBuffer;
    lightBuffer: GPUBuffer;
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
    this.device.queue.writeBuffer(quadBuffer, 0, quadData);
    this.device.queue.writeBuffer(lightBuffer, 0, lightData);
    const bindGroup = createBindGroup(this.device, this.layouts.scene, [
      { buffer: this.uniformBuffer },
      { buffer: quadBuffer },
      { buffer: lightBuffer },
    ]);
    return { quadBuffer, lightBuffer, bindGroup };
  }

  setSettings(next: RenderSettings): void {
    const previous = this.settings;
    this.settings = next;
    if (previous.scene !== next.scene) {
      this.quadBuffer.destroy();
      this.lightBuffer.destroy();
      this.scene = buildScene(next.scene);
      const uploaded = this.uploadScene(this.scene);
      this.quadBuffer = uploaded.quadBuffer;
      this.lightBuffer = uploaded.lightBuffer;
      this.sceneBindGroup = uploaded.bindGroup;
    }
    if (requiresAccumulationReset(previous, next)) {
      this.resetAccumulation();
    }
  }

  /**
   * Lambertian-only transport makes accumulated irradiance view-independent,
   * so ReSTIR keeps its history across camera motion; the reference path
   * tracer averages full radiance per pixel and has to start over.
   */
  notifyCameraChanged(): void {
    if (this.settings.mode === "reference") {
      this.resetAccumulation();
    }
  }

  resetAccumulation(): void {
    this.accumFrames = 0;
  }

  get stats(): RendererStats {
    return {
      width: this.targets?.width ?? 0,
      height: this.targets?.height ?? 0,
      accumFrames: this.accumFrames,
      frameMs: this.lastFrameMs,
    };
  }

  private resolveSize(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.settings.resolutionScale;
    const rawWidth = Math.max(1, Math.floor(rect.width * scale));
    const rawHeight = Math.max(1, Math.floor(rect.height * scale));
    const overflow = (rawWidth * rawHeight) / MAX_PIXELS;
    if (overflow <= 1) return { width: rawWidth, height: rawHeight };
    const shrink = 1 / Math.sqrt(overflow);
    return {
      width: Math.max(1, Math.floor(rawWidth * shrink)),
      height: Math.max(1, Math.floor(rawHeight * shrink)),
    };
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

    const position = texture("position", "rgba32float", 2);
    const normal = texture("normal", "rgba16float", 2);
    const albedo = texture("albedo", "rgba8unorm", 1);
    const emission = texture("emission", "rgba16float", 1);
    const illumination = texture("illumination", "rgba16float", 1);
    const history = texture("history", "rgba16float", 2);
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
        ...position,
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
          view(at(position, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          view(at(emission, 0)),
        ]),
      ),
      di: parities.map((p) =>
        createBindGroup(device, this.layouts.resample, [
          view(at(position, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          view(at(position, 1 - p)),
          view(at(normal, 1 - p)),
          { buffer: at(diFinal, 1 - p) },
          { buffer: diScratch },
        ]),
      ),
      diSpatial: parities.map((p) =>
        createBindGroup(device, this.layouts.spatial, [
          view(at(position, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          { buffer: diScratch },
          { buffer: at(diFinal, p) },
        ]),
      ),
      gi: parities.map((p) =>
        createBindGroup(device, this.layouts.resample, [
          view(at(position, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          view(at(position, 1 - p)),
          view(at(normal, 1 - p)),
          { buffer: at(giFinal, 1 - p) },
          { buffer: giScratch },
        ]),
      ),
      giSpatial: parities.map((p) =>
        createBindGroup(device, this.layouts.spatial, [
          view(at(position, p)),
          view(at(normal, p)),
          view(at(albedo, 0)),
          { buffer: giScratch },
          { buffer: at(giFinal, p) },
        ]),
      ),
      shade: parities.map((p) =>
        createBindGroup(device, this.layouts.shade, [
          view(at(position, p)),
          view(at(normal, p)),
          { buffer: at(diFinal, p) },
          { buffer: at(giFinal, p) },
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
          view(at(position, p)),
          view(at(normal, p)),
          view(at(position, 1 - p)),
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
            view(at(position, p)),
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
    };
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
    if (current !== null) {
      for (const t of current.textures) t.destroy();
      for (const b of current.buffers) b.destroy();
    }
    this.canvas.width = width;
    this.canvas.height = height;
    const targets = this.createTargets(width, height);
    this.targets = targets;
    this.resetAccumulation();
    return targets;
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
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  renderFrame(camera: OrbitCamera): void {
    if (this.destroyed) return;
    // Wall-clock interval between submissions. requestAnimationFrame paces the
    // loop, so this reports the real (vsync- or GPU-bound) frame time rather
    // than the negligible command-encoding cost.
    const started = performance.now();
    this.lastFrameMs = this.lastFrameAt > 0 ? started - this.lastFrameAt : 0;
    this.lastFrameAt = started;
    const targets = this.ensureTargets();
    const basis = cameraBasis(camera, targets.width / targets.height);
    this.writeUniforms(basis, targets);

    const parity = this.parity;
    const groupsX = Math.ceil(targets.width / WORKGROUP_SIZE);
    const groupsY = Math.ceil(targets.height / WORKGROUP_SIZE);
    const encoder = this.device.createCommandEncoder();

    const dispatch = (
      pipeline: GPUComputePipeline,
      passBindGroup: GPUBindGroup,
    ): void => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.sceneBindGroup);
      pass.setBindGroup(1, passBindGroup);
      pass.dispatchWorkgroups(groupsX, groupsY);
      pass.end();
    };

    const reference = this.settings.mode === "reference";
    if (reference) {
      dispatch(this.pipelines.reference, at(targets.reference, parity));
    } else {
      dispatch(this.pipelines.gbuffer, at(targets.gbuffer, parity));
      dispatch(this.pipelines.di, at(targets.di, parity));
      dispatch(this.pipelines.diSpatial, at(targets.diSpatial, parity));
      dispatch(this.pipelines.gi, at(targets.gi, parity));
      dispatch(this.pipelines.giSpatial, at(targets.giSpatial, parity));
      dispatch(this.pipelines.shade, at(targets.shade, parity));
      dispatch(this.pipelines.temporal, at(targets.temporal, parity));
      const chain = at(targets.atrous, parity);
      for (let i = 0; i < ATROUS_ITERATIONS; i++) {
        dispatch(this.pipelines.atrous, at(chain, i));
      }
    }

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    renderPass.setPipeline(
      reference
        ? this.pipelines.presentReference
        : this.pipelines.presentRestir,
    );
    renderPass.setBindGroup(0, this.presentUniformBindGroup);
    renderPass.setBindGroup(
      1,
      reference ? at(targets.presentReference, parity) : targets.presentRestir,
    );
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([encoder.finish()]);

    this.previousBasis = basis;
    this.parity = 1 - parity;
    this.frame += 1;
    this.accumFrames += 1;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const current = this.targets;
    if (current !== null) {
      for (const t of current.textures) t.destroy();
      for (const b of current.buffers) b.destroy();
    }
    this.quadBuffer.destroy();
    this.lightBuffer.destroy();
    this.uniformBuffer.destroy();
    for (const buffer of this.atrousBuffers) buffer.destroy();
    this.device.destroy();
  }
}
