import { captureSpatialDispatch } from "./bdpt-spatial-profile-capture.js";
import { splitSpatialShader } from "./bdpt-spatial-profile-shaders.js";

export const profileSpatial = async ({
  scene = "classic",
  samples = 4,
  bounces = 3,
  width = 352,
  height = 738,
  repeats = 12,
  expectedShader,
  referenceSpatial,
} = {}) => {
  if (
    !["classic", "manyLights", "glassShapes"].includes(scene) ||
    ![samples, bounces, width, height, repeats].every(Number.isSafeInteger) ||
    samples < 0 ||
    samples > 32 ||
    bounces < 1 ||
    bounces > 12 ||
    width < 1 ||
    height < 1 ||
    repeats < 2 ||
    repeats % 2 !== 0
  )
    throw Error("Invalid spatial profiling settings");
  const { GiRenderer } = await import("/src/gi/renderer.ts");
  const { DEFAULT_SETTINGS } = await import("/src/gi/settings.ts");
  const { DEFAULT_CAMERA } = await import("/src/gi/camera.ts");
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `width:${width}px;height:${height}px`;
  document.body.append(canvas);
  const capture = captureSpatialDispatch();
  const resources = [];
  const errors = [];
  let renderer;
  try {
    renderer = await GiRenderer.create(canvas, {
      ...DEFAULT_SETTINGS,
      restirMethod: "bdpt",
      scene,
      spatialSamples: samples,
      maxBounces: bounces,
      smoothMotion: false,
      resolutionScale: 1 / devicePixelRatio,
    });
    const device = renderer.device;
    if (!device.features.has("timestamp-query"))
      throw Error("Spatial profiling requires timestamp-query support");
    device.addEventListener("uncapturederror", (event) =>
      errors.push(event.error.message),
    );
    device.pushErrorScope("validation");
    for (let i = 0; i < 10; i++) {
      const count = renderer.stats.accumFrames;
      while (renderer.stats.accumFrames === count) {
        renderer.renderFrame(DEFAULT_CAMERA);
        await renderer.bdptInitialization;
        await renderer.bdptPresentation;
        if (renderer.allocationError) throw Error(renderer.allocationError);
      }
    }
    await device.queue.onSubmittedWorkDone();
    const frozen = capture.get();
    capture.restore();
    if (
      expectedShader !== undefined &&
      frozen.code.replace(
        /const BDPT_MAX_VERTICES: u32 = \d+u;/,
        "const BDPT_MAX_VERTICES: u32 = 32u;",
      ) !== expectedShader
    )
      throw Error(
        "Served spatial shader differs from disk; restart the dev server",
      );
    const shaderHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(frozen.code),
        ),
      ),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    if (canvas.width !== width || canvas.height !== height)
      throw Error(`Unexpected render size ${canvas.width}x${canvas.height}`);
    if (
      frozen.groups[2][1]?.some((offset) => offset !== 0) ||
      frozen.dispatch[0] *
        frozen.descriptor.compute.constants.BDPT_WORKGROUP_SIZE <
        width ||
      frozen.dispatch[1] *
        frozen.descriptor.compute.constants.BDPT_WORKGROUP_SIZE <
        height
    )
      throw Error(
        "Profiling requires an untiled full-image dispatch; use bdptDispatchPixels=0",
      );
    const buffer = (size, usage) => {
      const result = device.createBuffer({ size, usage });
      resources.push(result);
      return result;
    };
    const domainBytes = width * height * 272;
    const domains = buffer(
      domainBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });
    const group = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: domains } }],
    });
    const split = splitSpatialShader(frozen.code);
    if (referenceSpatial !== undefined) {
      const marker =
        "@group(1) @binding(0) var<storage, read> temporalReservoirs:";
      if (frozen.code.split(marker).length !== 2)
        throw Error("Cannot locate spatial entry for reference comparison");
      split.reference =
        frozen.code.slice(0, frozen.code.indexOf(marker)) + referenceSpatial;
    }
    const splitLayout = device.createPipelineLayout({
      bindGroupLayouts: [
        ...[0, 1, 2].map((index) => frozen.pipeline.getBindGroupLayout(index)),
        layout,
      ],
    });
    const pipelines = { original: frozen.pipeline };
    for (const [label, code] of Object.entries(split)) {
      const module = device.createShaderModule({ label, code });
      const info = await module.getCompilationInfo();
      const failures = info.messages.filter(
        (message) => message.type === "error",
      );
      if (failures.length)
        throw Error(failures.map((message) => message.message).join("\n"));
      pipelines[label] = await device.createComputePipelineAsync({
        label,
        layout: splitLayout,
        compute: { ...frozen.descriptor.compute, module },
      });
    }
    const query = device.createQuerySet({ type: "timestamp", count: 6 });
    resources.push(query);
    const resolve = buffer(
      48,
      GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    );
    const times = buffer(48, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const readback = buffer(
      frozen.output.size,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const domainReadback = buffer(
      domainBytes,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const record = (encoder, label, index) => {
      const pass = encoder.beginComputePass({
        timestampWrites: {
          querySet: query,
          beginningOfPassWriteIndex: index * 2,
          endOfPassWriteIndex: index * 2 + 1,
        },
      });
      pass.setPipeline(pipelines[label]);
      frozen.groups.forEach((args, index) => pass.setBindGroup(index, ...args));
      if (label !== "original") pass.setBindGroup(3, group);
      pass.dispatchWorkgroups(...frozen.dispatch);
      pass.end();
    };
    const readOutput = async (labels) => {
      const encoder = device.createCommandEncoder();
      labels.forEach((label, index) => record(encoder, label, index));
      encoder.copyBufferToBuffer(
        frozen.output,
        0,
        readback,
        0,
        frozen.output.size,
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const result = new Uint32Array(readback.getMappedRange()).slice();
      readback.unmap();
      return result;
    };
    const original = await readOutput(["original"]);
    const values = new Float32Array(original.buffer);
    let positivePixels = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const radiance = values.subarray(pixel * 40 + 4, pixel * 40 + 7);
      if (!radiance.every(Number.isFinite))
        throw Error("Nonfinite production radiance");
      if (radiance.some((value) => value > 0)) positivePixels++;
    }
    if (!positivePixels) throw Error("Production output has no radiance");
    if (referenceSpatial !== undefined) {
      const reference = await readOutput(["reference"]);
      const mismatches = original.reduce(
        (count, word, index) => count + Number(word !== reference[index]),
        0,
      );
      if (mismatches)
        throw Error(`Reference differs from production in ${mismatches} words`);
    }
    const separated = await readOutput(["selection", "replay"]);
    const mismatchWords = original.reduce(
      (count, word, index) => count + Number(word !== separated[index]),
      0,
    );
    if (mismatchWords)
      throw Error(`Split differs from production in ${mismatchWords} words`);
    const domainEncoder = device.createCommandEncoder();
    domainEncoder.copyBufferToBuffer(
      domains,
      0,
      domainReadback,
      0,
      domainBytes,
    );
    device.queue.submit([domainEncoder.finish()]);
    await domainReadback.mapAsync(GPUMapMode.READ);
    const domainData = new Uint32Array(domainReadback.getMappedRange());
    let activePixels = 0;
    let acceptedNeighbors = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const count = domainData[pixel * 68 + 66];
      if (count > 1) {
        activePixels++;
        acceptedNeighbors += count - 1;
      }
    }
    domainReadback.unmap();
    if (samples > 0 && activePixels === 0)
      throw Error("No accepted spatial neighbors in profile");
    const runs = [];
    for (let iteration = -4; iteration < repeats; iteration++) {
      const order =
        iteration % 2 === 0
          ? ["original", "selection", "replay"]
          : ["selection", "replay", "original"];
      const encoder = device.createCommandEncoder();
      order.forEach((label, index) => record(encoder, label, index));
      encoder.resolveQuerySet(query, 0, 6, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, times, 0, 48);
      device.queue.submit([encoder.finish()]);
      await times.mapAsync(GPUMapMode.READ);
      const values = new BigUint64Array(times.getMappedRange());
      const ms = {};
      order.forEach((label, index) => {
        const begin = values[index * 2];
        const end = values[index * 2 + 1];
        if (begin === 0n || end < begin) throw Error("Invalid GPU timestamps");
        ms[label] = Number(end - begin) / 1e6;
      });
      times.unmap();
      if (iteration >= 0) runs.push({ order, ms });
    }
    const validation = await device.popErrorScope();
    if (validation) errors.push(validation.message);
    if (errors.length) throw Error(errors.join("\n"));
    return {
      shaderHash,
      settings: { ...renderer.settings },
      camera: DEFAULT_CAMERA,
      scene,
      samples,
      bounces,
      width,
      height,
      repeats,
      workgroupSize: frozen.descriptor.compute.constants.BDPT_WORKGROUP_SIZE,
      capacity: Number(
        /const BDPT_MAX_VERTICES: u32 = (\d+)u;/.exec(frozen.code)[1],
      ),
      userAgent: navigator.userAgent,
      adapter: {
        isFallbackAdapter: frozen.adapterInfo.isFallbackAdapter,
        vendor: frozen.adapterInfo.vendor,
        architecture: frozen.adapterInfo.architecture,
        description: frozen.adapterInfo.description,
      },
      warmupFrames: 10,
      frozenFrame: renderer.stats.accumFrames,
      warmupPairs: 4,
      mismatchWords,
      positivePixels,
      activePixels,
      acceptedNeighbors,
      runs,
    };
  } finally {
    capture.restore();
    resources.forEach((resource) => resource.destroy());
    renderer?.destroy();
    canvas.remove();
  }
};
