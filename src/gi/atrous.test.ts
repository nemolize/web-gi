import { describe, expect, it } from "vitest";

import {
  ATROUS_HALO,
  ATROUS_ITERATIONS,
  ATROUS_KERNEL_RADIUS,
  atrousWorkgroupSize,
  BASELINE_TILED_ATROUS_STORAGE_BYTES,
  BASELINE_TILED_ATROUS_TILE_WIDTH,
  BASELINE_TILED_ATROUS_WORKGROUP_SIZE,
  DEFAULT_WORKGROUP_SIZE,
  LARGE_TILED_ATROUS_STORAGE_BYTES,
  LARGE_TILED_ATROUS_TILE_WIDTH,
  LARGE_TILED_ATROUS_WORKGROUP_SIZE,
  selectAtrousVariant,
  supportsBaselineTiledAtrous,
  supportsLargeTiledAtrous,
} from "@/gi/atrous";
import tiledWgsl from "@/gi/shaders/denoise-atrous.wgsl?raw";
import baselineWgsl from "@/gi/shaders/denoise-atrous-baseline.wgsl?raw";
import atrousCommonWgsl from "@/gi/shaders/denoise-atrous-common.wgsl?raw";
import fallbackWgsl from "@/gi/shaders/denoise-atrous-fallback.wgsl?raw";
import tiledCommonWgsl from "@/gi/shaders/denoise-atrous-tiled-common.wgsl?raw";

const limits = (
  overrides: Partial<Parameters<typeof supportsLargeTiledAtrous>[0]> = {},
): Parameters<typeof supportsLargeTiledAtrous>[0] => ({
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

describe("tiled a-trous support", () => {
  it("accepts a device with a 16x16 group and the 24 KiB tile", () => {
    expect(supportsLargeTiledAtrous(limits())).toBe(true);
    expect(LARGE_TILED_ATROUS_STORAGE_BYTES).toBe(24 * 1024);
  });

  it("accepts the 8x8 tile at WebGPU's baseline storage limit", () => {
    const baseline = limits({ maxComputeWorkgroupStorageSize: 16 * 1024 });
    expect(supportsBaselineTiledAtrous(baseline)).toBe(true);
    expect(BASELINE_TILED_ATROUS_STORAGE_BYTES).toBe(13_824);
  });

  it.each([
    ["storage", { maxComputeWorkgroupStorageSize: 16 * 1024 }],
    ["invocations", { maxComputeInvocationsPerWorkgroup: 128 }],
    ["width", { maxComputeWorkgroupSizeX: 8 }],
    ["height", { maxComputeWorkgroupSizeY: 8 }],
  ])("rejects an insufficient 16x16 %s limit", (_name, override) => {
    expect(supportsLargeTiledAtrous(limits(override))).toBe(false);
  });
});

describe("selectAtrousVariant", () => {
  it("uses the 16x16 path by default when the device supports it", () => {
    expect(selectAtrousVariant(limits(), "")).toBe("tiled-16");
  });

  it("allows a preview to force the texture-backed A/B baseline", () => {
    expect(selectAtrousVariant(limits(), "?atrous=fallback")).toBe("fallback");
  });

  it("allows a preview to force the baseline tiled path", () => {
    expect(selectAtrousVariant(limits(), "?atrous=8")).toBe("tiled-8");
  });

  it("preserves the fallback on a device below the 24 KiB limit", () => {
    expect(
      selectAtrousVariant(
        limits({ maxComputeWorkgroupStorageSize: 16 * 1024 }),
        "",
      ),
    ).toBe("fallback");
  });

  it("does not force baseline tiling when its limits are unsupported", () => {
    expect(
      selectAtrousVariant(
        limits({ maxComputeWorkgroupStorageSize: 8 * 1024 }),
        "?atrous=8",
      ),
    ).toBe("fallback");
  });

  it("maps every variant to its dispatch workgroup size", () => {
    expect(atrousWorkgroupSize("tiled-16")).toBe(16);
    expect(atrousWorkgroupSize("tiled-8")).toBe(DEFAULT_WORKGROUP_SIZE);
    expect(atrousWorkgroupSize("fallback")).toBe(DEFAULT_WORKGROUP_SIZE);
  });
});

describe("a-trous WGSL contracts", () => {
  it.each([
    [
      "large",
      tiledWgsl,
      LARGE_TILED_ATROUS_WORKGROUP_SIZE,
      LARGE_TILED_ATROUS_TILE_WIDTH,
    ],
    [
      "baseline",
      baselineWgsl,
      BASELINE_TILED_ATROUS_WORKGROUP_SIZE,
      BASELINE_TILED_ATROUS_TILE_WIDTH,
    ],
  ])(
    "keeps the %s tiled geometry aligned with the dispatch constants",
    (_name, source, workgroupSize, tileWidth) => {
      const maxStride = 1 << (ATROUS_ITERATIONS - 1);
      expect(ATROUS_HALO).toBe(ATROUS_KERNEL_RADIUS * maxStride);
      expect(tileWidth).toBe(workgroupSize + 2 * ATROUS_HALO);
      expect(integerConstant(source, "ATROUS_WORKGROUP_SIZE")).toBe(
        workgroupSize,
      );
      expect(integerConstant(source, "TILE_WIDTH")).toBe(tileWidth);
      expect(integerConstant(source, "TILE_HALO")).toBe(ATROUS_HALO);
    },
  );

  it("shares the cooperative loader across both tiled geometries", () => {
    expect(tiledCommonWgsl).toContain(
      "workgroupTexels = ATROUS_WORKGROUP_SIZE * ATROUS_WORKGROUP_SIZE",
    );
    expect(atrousCommonWgsl).toContain(
      "@workgroup_size(ATROUS_WORKGROUP_SIZE, ATROUS_WORKGROUP_SIZE)",
    );
  });

  it("accounts for every workgroup array in the requested storage limit", () => {
    const declarations = [
      ...tiledCommonWgsl.matchAll(/var<workgroup>[^;]+;/g),
    ].map((match) => match[0]);
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
    expect(LARGE_TILED_ATROUS_STORAGE_BYTES).toBe(
      LARGE_TILED_ATROUS_TILE_WIDTH ** 2 * bytesPerTexel,
    );
    expect(BASELINE_TILED_ATROUS_STORAGE_BYTES).toBe(
      BASELINE_TILED_ATROUS_TILE_WIDTH ** 2 * bytesPerTexel,
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
    const kernel = /const\s+KERNEL\s*=\s*array<f32,\s*(\d+)>\(([^)]*)\)/.exec(
      atrousCommonWgsl,
    );
    expect(Number(kernel?.[1])).toBe(ATROUS_KERNEL_RADIUS * 2 + 1);
    expect(kernel?.[2]?.split(",")).toHaveLength(ATROUS_KERNEL_RADIUS * 2 + 1);
    expect(atrousCommonWgsl).toMatch(
      /KERNEL\s*\[\s*dx\s*\+\s*2\s*\]\s*\*\s*KERNEL\s*\[\s*dy\s*\+\s*2\s*\]/,
    );
    expect(atrousCommonWgsl).not.toMatch(/\bvar\s+\w*kernel\w*\b/i);
  });

  it("keeps one filter entry point across all loader variants", () => {
    expect(integerConstant(fallbackWgsl, "ATROUS_WORKGROUP_SIZE")).toBe(
      DEFAULT_WORKGROUP_SIZE,
    );
    expect(atrousCommonWgsl).toContain("fn main(");
    expect(tiledWgsl).not.toContain("fn main(");
    expect(baselineWgsl).not.toContain("fn main(");
    expect(tiledCommonWgsl).not.toContain("fn main(");
    expect(fallbackWgsl).not.toContain("fn main(");
    expect(tiledWgsl).not.toContain("var kernel");
    expect(baselineWgsl).not.toContain("var kernel");
    expect(tiledCommonWgsl).not.toContain("var kernel");
    expect(fallbackWgsl).not.toContain("var kernel");
  });
});
