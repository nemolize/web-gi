import { describe, expect, it, vi } from "vitest";

import { allocateBdptResources } from "./allocation";

describe("BDPT allocation scopes", () => {
  it("pops both scopes before asynchronous results settle", async () => {
    let release;
    const validation = new Promise((resolve) => {
      release = resolve;
    });
    const device = {
      pushErrorScope: vi.fn(),
      popErrorScope: vi
        .fn()
        .mockReturnValueOnce(validation)
        .mockResolvedValueOnce(null),
    };
    const pending = allocateBdptResources(device, () => "resources");
    expect(device.pushErrorScope.mock.calls).toEqual([
      ["out-of-memory"],
      ["validation"],
    ]);
    expect(device.popErrorScope).toHaveBeenCalledTimes(2);
    release(null);
    await expect(pending).resolves.toBe("resources");
  });

  it("reports asynchronous allocation failure", async () => {
    const device = {
      pushErrorScope: vi.fn(),
      popErrorScope: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ message: "allocation exhausted" }),
    };
    await expect(
      allocateBdptResources(device, () => "invalid buffers"),
    ).rejects.toThrow("allocation exhausted");
  });

  it("balances scopes even when resource creation throws", async () => {
    const device = {
      pushErrorScope: vi.fn(),
      popErrorScope: vi.fn().mockResolvedValue(null),
    };
    const error = new Error("creation failed");
    await expect(
      allocateBdptResources(device, () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(device.popErrorScope).toHaveBeenCalledTimes(2);
  });
});
