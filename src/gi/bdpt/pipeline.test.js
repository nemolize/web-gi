import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bdptVertexLimit,
  configureBdptWorkgroups,
  createBdptPipeline,
  dispatchBdptPipeline,
} from "./pipeline";

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

it("keeps every uniform-budget vertex and separates compiled capacities", async () => {
  expect(bdptVertexLimit(3, 0)).toBe(10);
  expect(bdptVertexLimit(6, 3)).toBe(21);
  expect(bdptVertexLimit(12, 20)).toBe(32);
  const device = fixture();
  device.createComputePipelineAsync.mockImplementation(async () => ({}));
  const layout = {};
  const small = await createBdptPipeline(
    device,
    layout,
    "camera",
    "",
    {},
    undefined,
    10,
  );
  const large = await createBdptPipeline(
    device,
    layout,
    "camera",
    "",
    {},
    undefined,
    21,
  );
  expect(large).not.toBe(small);
  expect(
    await createBdptPipeline(device, layout, "camera", "", {}, undefined, 10),
  ).toBe(small);
  expect(
    device.createShaderModule.mock.calls.map(
      ([d]) => /const BDPT_MAX_VERTICES: u32 = (\d+)u;/.exec(d.code)?.[1],
    ),
  ).toEqual(["10", "21"]);
  for (const invalid of [1, 33, 2.5, NaN]) {
    await expect(
      createBdptPipeline(device, layout, "camera", "", {}, undefined, invalid),
    ).rejects.toThrow("vertex capacity");
  }
});

it("starts at the requested group limit and keeps device caches separate", async () => {
  const device = fixture();
  device.createComputePipelineAsync.mockResolvedValue({});
  const layout = {};
  const compile = () => createBdptPipeline(device, layout, "camera", "", {});
  const normal = await compile();
  expect(configureBdptWorkgroups(device, "?bdptWorkgroupSize=4")).toBe(4);
  device.createComputePipelineAsync.mockRejectedValueOnce(
    new PipelineError("internal"),
  );
  expect((await compile()).workgroupSize).toBe(1);
  configureBdptWorkgroups(device, "?bdptWorkgroupSize=1");
  expect((await compile()).workgroupSize).toBe(1);
  configureBdptWorkgroups(device, "?bdptWorkgroupSize=8");
  expect(await compile()).toBe(normal);
  expect(
    device.createComputePipelineAsync.mock.calls.map(
      ([d]) => d.compute.constants.BDPT_WORKGROUP_SIZE,
    ),
  ).toEqual([8, 4, 1, 1]);
  const other = fixture();
  other.createComputePipelineAsync.mockResolvedValue({});
  expect(
    (await createBdptPipeline(other, {}, "camera", "", {})).workgroupSize,
  ).toBe(8);
  for (const raw of ["", "0", "2", "16", "4.0", "04", "garbage"]) {
    expect(configureBdptWorkgroups(device, `?bdptWorkgroupSize=${raw}`)).toBe(
      8,
    );
  }
});

it("defaults Qualcomm and Adreno to 4x4 while preserving explicit overrides", async () => {
  for (const adapter of [
    { vendor: "Qualcomm", architecture: "", description: "" },
    { vendor: "", architecture: "adreno-8xx", description: "" },
    { vendor: "", architecture: "", description: "Adreno 830" },
  ]) {
    const device = fixture();
    device.createComputePipelineAsync.mockResolvedValue({});
    for (const search of ["", "?bdptWorkgroupSize=2", "?bdptWorkgroupSize=bad"])
      expect(configureBdptWorkgroups(device, search, adapter)).toBe(4);
    expect(
      (await createBdptPipeline(device, {}, "camera", "", {})).workgroupSize,
    ).toBe(4);
    expect(
      configureBdptWorkgroups(device, "?bdptWorkgroupSize=8", adapter),
    ).toBe(8);
    expect(
      configureBdptWorkgroups(device, "?bdptWorkgroupSize=1", adapter),
    ).toBe(1);
  }
  expect(
    configureBdptWorkgroups(fixture(), "", {
      vendor: "apple",
      architecture: "",
      description: "",
    }),
  ).toBe(8);
});
