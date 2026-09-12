import type { BdptCheckpoint } from "@/gi/bdpt/pipeline";
import { createBdptRuntime } from "@/gi/bdpt/runtime";
import { cameraBasis, DEFAULT_CAMERA } from "@/gi/camera";
import type { DiagnosticSuite } from "@/gi/diagnostics/runner";
import {
  buildScene,
  packClusters,
  packGlassShapes,
  packLights,
  packQuads,
} from "@/gi/scene";

const run = async (
  device: GPUDevice,
  report: (line: string) => void,
  staged = false,
) => {
  const width = staged ? 353 : 39;
  const height = staged ? 738 : 31;
  const pixels = width * height;
  const buffers: GPUBuffer[] = [];
  const errors: string[] = [];
  let lost = false;
  void device.lost.then(() => {
    lost = true;
  });
  const onError = (event: GPUUncapturedErrorEvent) => {
    errors.push(event.error.message);
    report(`GPU ERROR: ${event.error.message}`);
  };
  device.addEventListener("uncapturederror", onError);
  const texture = device.createTexture({
    size: [width, height],
    format: "rgba16float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  let runtime: Awaited<ReturnType<typeof createBdptRuntime>> | undefined;
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ size, usage });
    buffers.push(result);
    return result;
  };
  try {
    const scene = buildScene(staged ? "classic" : "glassShapes");
    const camera = cameraBasis(DEFAULT_CAMERA, width / height);
    const data = new ArrayBuffer(224);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    const vector = (v: { x: number; y: number; z: number }) => [v.x, v.y, v.z];
    f.set([
      ...vector(camera.pos),
      camera.tanHalfFov,
      ...vector(camera.right),
      camera.aspect,
      ...vector(camera.up),
      0,
      ...vector(camera.forward),
      0,
    ]);
    f.copyWithin(16, 0, 16);
    u.set([width, height, 0, 0, scene.quads.length, scene.lights.length], 32);
    u[39] = staged ? 4 : 2;
    u[40] = 3;
    u[41] = staged ? 512 : 8;
    u[42] = 256 | 9 | 48;
    f[43] = staged ? 0.04 : 0.15;
    u.set(
      [
        scene.clusters.length,
        scene.occluderClusterCount,
        scene.glassShapes.length,
      ],
      45,
    );
    u[50] = width;
    u[51] = height;
    const resources = [
      data,
      packQuads(scene),
      packLights(scene),
      packClusters(scene),
      packGlassShapes(scene),
    ].map((value, index) => {
      const result = buffer(
        value.byteLength,
        GPUBufferUsage.COPY_DST |
          (index === 0 ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE),
      );
      device.queue.writeBuffer(result, 0, value);
      return result;
    });
    const uniform = resources[0];
    if (!uniform) throw new Error("Missing diagnostic uniforms");
    const layout = device.createBindGroupLayout({
      entries: resources.map((_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 0 ? "uniform" : "read-only-storage" },
      })),
    });
    const group = device.createBindGroup({
      layout,
      entries: resources.map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    report(
      "START production BDPT pipelines (default workgroup with compilation retries)",
    );
    runtime = await createBdptRuntime(
      device,
      layout,
      width,
      height,
      texture.createView(),
      report,
    );
    report("READY production BDPT pipelines");
    const initial = buffer(
      pixels * 160,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    const reused = buffer(
      pixels * 160,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const output = buffer(
      bytesPerRow * height,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    const summarize = (label: string, values: number[]) => {
      const finite = values.every(Number.isFinite);
      const positive = values.filter((value) => value > 0).length;
      const mean =
        values.reduce((sum, value) => sum + value, 0) / values.length;
      report(
        `${label}: finite=${finite} positive=${positive}/${values.length} mean=${mean}`,
      );
      if (!finite || positive === 0)
        errors.push(`${label}: non-finite or all-zero radiance`);
    };
    for (let frame = 0; frame < 3; frame++) {
      u[34] = frame;
      u[35] = frame;
      u[49] = frame;
      device.queue.writeBuffer(uniform, 0, data);
      report(`START frame ${frame} submit/readback`);
      const commands: { label: string; buffer: GPUCommandBuffer }[] = [];
      const checkpoint: BdptCheckpoint | undefined = staged
        ? (encoder, label) => {
            commands.push({ label, buffer: encoder.finish() });
            return device.createCommandEncoder();
          }
        : undefined;
      const encoder = runtime.record(
        device.createCommandEncoder(),
        group,
        () => undefined,
        checkpoint,
      );
      encoder.copyBufferToBuffer(
        runtime.initialReservoirs,
        0,
        initial,
        0,
        pixels * 160,
      );
      encoder.copyBufferToBuffer(
        runtime.reservoirs,
        0,
        reused,
        0,
        pixels * 160,
      );
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: output, bytesPerRow },
        [width, height],
      );
      if (staged) {
        commands.push({ label: "readback", buffer: encoder.finish() });
        for (const command of commands) {
          if (lost) throw new Error("GPU device lost before the next stage.");
          const startedAt = performance.now();
          report(`SUBMIT frame ${frame} ${command.label}`);
          try {
            device.queue.submit([command.buffer]);
            await device.queue.onSubmittedWorkDone();
            if (errors.length) throw new Error(errors.join("\n"));
            report(
              `COMPLETE frame ${frame} ${command.label} (${Math.round(performance.now() - startedAt)} ms)`,
            );
          } catch (error) {
            report(`FAIL frame ${frame} ${command.label}: ${String(error)}`);
            throw error;
          }
        }
      } else {
        device.queue.submit([encoder.finish()]);
      }
      await Promise.all(
        [initial, reused, output].map((resource) =>
          resource.mapAsync(GPUMapMode.READ),
        ),
      );
      for (const [label, resource] of [
        ["initial", initial],
        ["reuse", reused],
      ] as const) {
        const values = new Float32Array(resource.getMappedRange());
        const radiance: number[] = [];
        for (let pixel = 0; pixel < pixels; pixel++) {
          for (let channel = 0; channel < 3; channel++) {
            const a = pixel * 40;
            radiance.push(
              (values[a + 4 + channel] ?? NaN) *
                (values[a + 7] ?? NaN) *
                (values[a + 9] ?? NaN) +
                (values[a + 24 + channel] ?? NaN) *
                  (values[a + 27] ?? NaN) *
                  (values[a + 29] ?? NaN),
            );
          }
        }
        summarize(`frame ${frame} ${label}`, radiance);
      }
      const halves = new Uint16Array(output.getMappedRange());
      const radiance: number[] = [];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          for (let c = 0; c < 3; c++) {
            const bits = halves[(y * bytesPerRow) / 2 + x * 4 + c] ?? 0x7e00;
            const exponent = (bits >> 10) & 31;
            const fraction = bits & 1023;
            const magnitude =
              exponent === 31
                ? fraction
                  ? NaN
                  : Infinity
                : exponent === 0
                  ? fraction * 2 ** -24
                  : (1 + fraction / 1024) * 2 ** (exponent - 15);
            radiance.push(bits & 32768 ? -magnitude : magnitude);
          }
      summarize(`frame ${frame} resolve`, radiance);
      [initial, reused, output].forEach((resource) => resource.unmap());
    }
    if (errors.length) throw new Error(errors.join("\n"));
  } finally {
    runtime?.destroy();
    buffers.forEach((resource) => resource.destroy());
    texture.destroy();
    device.removeEventListener("uncapturederror", onError);
  }
};

export const bdptExecutionSuite: DiagnosticSuite = {
  id: "bdpt-execution",
  label: "ReSTIR BDPT execution",
  version: 3,
  description:
    "Runs three frames of a 39x31 glass scene through production BDPT passes and reads initial, reused, and resolved radiance. Does not test full-resolution presentation or denoising.",
  probes: [{ label: "glass / 39x31 / 3 frames", run }],
};

export const bdptStagedExecutionSuite: DiagnosticSuite = {
  id: "bdpt-stages",
  label: "ReSTIR BDPT staged execution",
  version: 1,
  description:
    "Runs three 353x738 classic frames with a GPU completion wait after each BDPT stage. Splits submissions for diagnosis; excludes presentation, denoising, and normal-renderer allocations. Success does not establish normal-renderer compatibility.",
  probes: [
    {
      label: "classic / 353x738 / 3 frames / staged",
      run: (device, report) => run(device, report, true),
    },
  ],
};
