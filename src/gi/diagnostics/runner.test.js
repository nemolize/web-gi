import { afterEach, describe, expect, it, vi } from "vitest";

import { createBdptPipeline } from "@/gi/bdpt/pipeline";

import { runGpuDiagnostics } from "./runner";

class PipelineError extends Error {}

afterEach(() => vi.unstubAllGlobals());

describe("runGpuDiagnostics device loss during a BDPT compile", () => {
  it("reports one event in the shared format and runs no later probe", async () => {
    vi.stubGlobal("GPUPipelineError", PipelineError);
    vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
    let lose;
    const lost = new Promise((resolve) => {
      lose = resolve;
    });
    const device = {
      lost,
      destroy: vi.fn(),
      createShaderModule: () => ({
        getCompilationInfo: async () => ({ messages: [] }),
      }),
      createPipelineLayout: () => ({}),
      createBindGroupLayout: () => ({}),
      createComputePipelineAsync: vi.fn(() => new Promise(() => undefined)),
    };
    vi.stubGlobal("navigator", {
      userAgent: "test",
      gpu: {
        requestAdapter: async () => ({
          info: { vendor: "", architecture: "", device: "", description: "" },
          requestDevice: async () => device,
        }),
      },
    });
    const second = vi.fn();
    const report = vi.fn();
    const run = runGpuDiagnostics(
      {
        id: "t",
        label: "t",
        version: 1,
        description: "",
        probes: [
          {
            label: "compile",
            run: async (probeDevice, probeReport) => {
              await createBdptPipeline(
                probeDevice,
                {},
                "bdpt-spatial",
                "",
                {},
                probeReport,
                10,
              );
            },
          },
          { label: "second", run: second },
        ],
      },
      report,
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1),
    );
    lose({ reason: "unknown", message: "Instance reference gone" });
    await run;
    const events = report.mock.calls
      .map(([line]) => line)
      .filter((line) => line.startsWith("BDPT_DEVICE_LOST "));
    expect(events).toEqual([
      `BDPT_DEVICE_LOST ${JSON.stringify({
        phase: "createComputePipelineAsync",
        pipeline: "bdpt-spatial",
        workgroupSize: 8,
        attempt: 1,
        maxVertices: 10,
        reason: "unknown",
        message: "Instance reference gone",
      })}`,
    ]);
    expect(second).not.toHaveBeenCalled();
  });
});
