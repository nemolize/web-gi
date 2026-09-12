import { afterEach, describe, expect, it, vi } from "vitest";

import { createBdptPipeline, dispatchBdptPipeline } from "./pipeline";

class PipelineError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const fixture = () => {
  vi.stubGlobal("GPUPipelineError", PipelineError);
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  return {
    createShaderModule: vi.fn(() => ({
      getCompilationInfo: async () => ({ messages: [] }),
    })),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createComputePipelineAsync: vi.fn(),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("BDPT compiler compatibility", () => {
  it("retries internal failures with smaller groups and caches the successful size", async () => {
    const device = fixture();
    const pipeline = {};
    device.createComputePipelineAsync
      .mockRejectedValueOnce(new PipelineError("internal"))
      .mockRejectedValueOnce(new PipelineError("internal"))
      .mockResolvedValue(pipeline);
    const layout = {};
    const compiled = await createBdptPipeline(device, layout, "camera", "", {});
    expect(compiled).toEqual({ pipeline, workgroupSize: 1 });
    expect(
      device.createComputePipelineAsync.mock.calls.map(
        ([descriptor]) => descriptor.compute.constants.BDPT_WORKGROUP_SIZE,
      ),
    ).toEqual([8, 4, 1]);
    expect(await createBdptPipeline(device, layout, "camera", "", {})).toBe(
      compiled,
    );
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(3);
    const pass = { setPipeline: vi.fn(), dispatchWorkgroups: vi.fn() };
    dispatchBdptPipeline(pass, compiled, 39, 31);
    expect(pass.setPipeline).toHaveBeenCalledWith(pipeline);
    expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(39, 31);
    dispatchBdptPipeline(pass, { pipeline, workgroupSize: 4 }, 39, 31);
    expect(pass.dispatchWorkgroups).toHaveBeenLastCalledWith(10, 8);
  });

  it("does not retry validation or unrelated failures", async () => {
    for (const error of [
      new PipelineError("validation"),
      new Error("device unavailable"),
    ]) {
      const device = fixture();
      device.createComputePipelineAsync.mockRejectedValue(error);
      await expect(
        createBdptPipeline(device, {}, "camera", "", {}),
      ).rejects.toBe(error);
      expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1);
    }
  });

  it("reports each attempted size when every internal compilation fails", async () => {
    const device = fixture();
    device.createComputePipelineAsync.mockRejectedValue(
      new PipelineError("internal"),
    );
    await expect(
      createBdptPipeline(device, {}, "camera", "", {}),
    ).rejects.toThrow("8x8: internal\n4x4: internal\n1x1: internal");
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(3);
  });
});

it("serializes compilation on each device and continues after a failed request", async () => {
  const device = fixture();
  let release;
  device.createComputePipelineAsync
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          release = () => reject(new PipelineError("validation"));
        }),
    )
    .mockResolvedValue({});
  const first = createBdptPipeline(device, {}, "first", "", {}).catch(
    (error) => error,
  );
  const second = createBdptPipeline(device, {}, "second", "", {});
  await vi.waitFor(() =>
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1),
  );
  release();
  expect(await first).toBeInstanceOf(PipelineError);
  await second;
  expect(
    device.createComputePipelineAsync.mock.calls.map(([d]) => d.label),
  ).toEqual(["first", "second"]);
});
