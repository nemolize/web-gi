import { describe, expect, it } from "vitest";

import {
  ATROUS_ITERATIONS,
  ATROUS_KERNEL_RADIUS,
  DEFAULT_WORKGROUP_SIZE,
  selectTiledAtrous,
  supportsTiledAtrous,
  TILED_ATROUS_HALO,
  TILED_ATROUS_STORAGE_BYTES,
  TILED_ATROUS_TILE_WIDTH,
  TILED_ATROUS_WORKGROUP_SIZE,
} from "@/gi/atrous";
import tiledWgsl from "@/gi/shaders/denoise-atrous.wgsl?raw";
import atrousCommonWgsl from "@/gi/shaders/denoise-atrous-common.wgsl?raw";
import fallbackWgsl from "@/gi/shaders/denoise-atrous-fallback.wgsl?raw";

const limits = (
  overrides: Partial<Parameters<typeof supportsTiledAtrous>[0]> = {},
): Parameters<typeof supportsTiledAtrous>[0] => ({
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupStorageSize: 32 * 1024,
  ...overrides,
});

const integerConstant = (source: string, name: string): number => {
  const match = new RegExp(`const ${name}: (?:u32|i32) = (\\d+)u?;`).exec(
    source,
  );
  if (match?.[1] === undefined) {
    throw new Error(`Missing WGSL constant ${name}`);
  }
  return Number(match[1]);
};

describe("supportsTiledAtrous", () => {
  it("accepts a device with a 16x16 group and the 24 KiB tile", () => {
    expect(supportsTiledAtrous(limits())).toBe(true);
    expect(TILED_ATROUS_STORAGE_BYTES).toBe(24 * 1024);
  });

  it.each([
    ["storage", { maxComputeWorkgroupStorageSize: 16 * 1024 }],
    ["invocations", { maxComputeInvocationsPerWorkgroup: 128 }],
    ["width", { maxComputeWorkgroupSizeX: 8 }],
    ["height", { maxComputeWorkgroupSizeY: 8 }],
  ])("rejects an insufficient %s limit", (_name, override) => {
    expect(supportsTiledAtrous(limits(override))).toBe(false);
  });
});

describe("selectTiledAtrous", () => {
  it("uses the tiled path by default when the device supports it", () => {
    expect(selectTiledAtrous(limits(), "")).toBe(true);
  });

  it("allows a preview to force the texture-backed A/B baseline", () => {
    expect(selectTiledAtrous(limits(), "?atrous=fallback")).toBe(false);
  });

  it("does not force tiling on a device below the storage limit", () => {
    expect(
      selectTiledAtrous(
        limits({ maxComputeWorkgroupStorageSize: 16 * 1024 }),
        "?atrous=tiled",
      ),
    ).toBe(false);
  });
});

describe("a-trous WGSL contracts", () => {
  it("keeps the tiled geometry aligned with the dispatch constants", () => {
    const maxStride = 1 << (ATROUS_ITERATIONS - 1);
    expect(TILED_ATROUS_HALO).toBe(ATROUS_KERNEL_RADIUS * maxStride);
    expect(TILED_ATROUS_TILE_WIDTH).toBe(
      TILED_ATROUS_WORKGROUP_SIZE + 2 * TILED_ATROUS_HALO,
    );
    expect(integerConstant(tiledWgsl, "ATROUS_WORKGROUP_SIZE")).toBe(
      TILED_ATROUS_WORKGROUP_SIZE,
    );
    expect(integerConstant(tiledWgsl, "TILE_WIDTH")).toBe(
      TILED_ATROUS_TILE_WIDTH,
    );
    expect(integerConstant(tiledWgsl, "TILE_HALO")).toBe(TILED_ATROUS_HALO);
    expect(tiledWgsl).toContain(
      "workgroupTexels = ATROUS_WORKGROUP_SIZE * ATROUS_WORKGROUP_SIZE",
    );
    expect(atrousCommonWgsl).toContain(
      "@workgroup_size(ATROUS_WORKGROUP_SIZE, ATROUS_WORKGROUP_SIZE)",
    );
  });

  it("accounts for every workgroup array in the requested storage limit", () => {
    const declarations = [...tiledWgsl.matchAll(/var<workgroup>[^;]+;/g)].map(
      (match) => match[0],
    );
    const elementTypes = declarations.flatMap((declaration) => {
      const match = /array<(f32|vec2u),\s*TILE_TEXELS>/.exec(declaration);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    expect(elementTypes).toHaveLength(declarations.length);
    expect(elementTypes).toEqual(["f32", "vec2u", "f32", "f32", "f32"]);
    const bytesPerTexel = elementTypes.reduce(
      (total, type) => total + (type === "vec2u" ? 8 : 4),
      0,
    );
    expect(TILED_ATROUS_STORAGE_BYTES).toBe(
      TILED_ATROUS_TILE_WIDTH ** 2 * bytesPerTexel,
    );
  });

  it("binds the shared filter radius and kernel width to the halo", () => {
    const loopBounds = [
      ...atrousCommonWgsl.matchAll(/for \(var (d[xy]) = -(\d+); \1 <= (\d+);/g),
    ].map((match) => [match[1], Number(match[2]), Number(match[3])]);
    expect(loopBounds).toEqual([
      ["dy", ATROUS_KERNEL_RADIUS, ATROUS_KERNEL_RADIUS],
      ["dx", ATROUS_KERNEL_RADIUS, ATROUS_KERNEL_RADIUS],
    ]);
    const kernel = /array<f32,\s*(\d+)>\(([^)]*)\)/.exec(atrousCommonWgsl);
    expect(Number(kernel?.[1])).toBe(ATROUS_KERNEL_RADIUS * 2 + 1);
    expect(kernel?.[2]?.split(",")).toHaveLength(ATROUS_KERNEL_RADIUS * 2 + 1);
  });

  it("keeps one filter entry point across both loader variants", () => {
    expect(integerConstant(fallbackWgsl, "ATROUS_WORKGROUP_SIZE")).toBe(
      DEFAULT_WORKGROUP_SIZE,
    );
    expect(atrousCommonWgsl).toContain("fn main(");
    expect(atrousCommonWgsl).toContain("var kernel = array<f32, 5>");
    expect(tiledWgsl).not.toContain("fn main(");
    expect(fallbackWgsl).not.toContain("fn main(");
    expect(tiledWgsl).not.toContain("var kernel");
    expect(fallbackWgsl).not.toContain("var kernel");
  });
});
