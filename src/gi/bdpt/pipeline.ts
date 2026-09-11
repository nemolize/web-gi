import camera from "@/gi/shaders/bdpt-camera.wgsl?raw";
import candidate from "@/gi/shaders/bdpt-candidate.wgsl?raw";
import initial from "@/gi/shaders/bdpt-initial.wgsl?raw";
import mis from "@/gi/shaders/bdpt-mis.wgsl?raw";
import replay from "@/gi/shaders/bdpt-replay.wgsl?raw";
import resampling from "@/gi/shaders/bdpt-resampling.wgsl?raw";
import reservoir from "@/gi/shaders/bdpt-reservoir.wgsl?raw";
import subpath from "@/gi/shaders/bdpt-subpath.wgsl?raw";
import transport from "@/gi/shaders/bdpt-transport.wgsl?raw";
import common from "@/gi/shaders/common.wgsl?raw";
import scene from "@/gi/shaders/scene.wgsl?raw";

const prefix = [
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
].join("\n");

export const createBdptPipeline = async (
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  label: string,
  body: string,
  passLayout: GPUBindGroupLayout,
) => {
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
  return device.createComputePipelineAsync({
    label,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [sceneLayout, passLayout],
    }),
    compute: { module, entryPoint: "main" },
  });
};
