import { afterEach, expect, it, vi } from "vitest";

import { createBdptPipeline } from "@/gi/bdpt/pipeline";
import { GiRenderer } from "@/gi/renderer";

class PipelineError extends Error {}

afterEach(() => vi.unstubAllGlobals());

it("puts the compile-time loss event in the report before deviceLost consumers run", async () => {
  vi.stubGlobal("GPUPipelineError", PipelineError);
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  let lose;
  const device = {
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    createShaderModule: () => ({
      getCompilationInfo: async () => ({ messages: [] }),
    }),
    createPipelineLayout: () => ({}),
    createBindGroupLayout: () => ({}),
    createComputePipelineAsync: vi.fn(() => new Promise(() => undefined)),
  };
  const lines = [];
  const report = (line) => lines.push(line);
  const renderer = Object.create(GiRenderer.prototype);
  Object.assign(renderer, { device, report });
  const consumed = renderer.deviceLost;

  const compile = createBdptPipeline(
    device,
    {},
    "bdpt-spatial",
    "",
    {},
    report,
    10,
  ).catch((error) => error);
  await vi.waitFor(() =>
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1),
  );
  lose({ reason: "unknown", message: "gone" });

  await consumed;
  expect(
    lines.filter((line) => line.startsWith("BDPT_DEVICE_LOST ")),
  ).toHaveLength(1);

  await compile;
  expect(
    lines.filter((line) => line.startsWith("BDPT_DEVICE_LOST ")),
  ).toHaveLength(1);
});
