import { captureSpatialDispatch } from "./bdpt-spatial-profile-capture.js";

export const validSpatialSettings = ({
  scene,
  samples,
  bounces,
  width,
  height,
}) =>
  ["classic", "manyLights", "glassShapes"].includes(scene) &&
  [samples, bounces, width, height].every(Number.isSafeInteger) &&
  samples >= 0 &&
  samples <= 32 &&
  bounces >= 1 &&
  bounces <= 12 &&
  width >= 1 &&
  height >= 1;

export const withFrozenSpatial = async (
  { scene, samples, bounces, width, height, expectedShader },
  run,
) => {
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
    const result = await run({
      device,
      frozen,
      shaderHash,
      buffer,
      track: (resource) => {
        resources.push(resource);
        return resource;
      },
      describe: () => ({
        shaderHash,
        settings: { ...renderer.settings },
        camera: DEFAULT_CAMERA,
        scene,
        samples,
        bounces,
        width,
        height,
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
      }),
    });
    const validation = await device.popErrorScope();
    if (validation) errors.push(validation.message);
    if (errors.length) throw Error(errors.join("\n"));
    return result;
  } finally {
    capture.restore();
    resources.forEach((resource) => resource.destroy());
    renderer?.destroy();
    canvas.remove();
  }
};
