import { add, dot, length, scale, sub, vec3 } from "@/gi/math";
import type { Quad } from "@/gi/scene";
import {
  buildScene,
  isInsideRoom,
  LIGHT_STRIDE_BYTES,
  makeBox,
  makeQuad,
  packLights,
  packQuads,
  QUAD_STRIDE_BYTES,
  quadCorners,
  SCENE_VARIANTS,
} from "@/gi/scene";

const NO_EMISSION = { albedo: vec3(1, 1, 1), emission: vec3(0, 0, 0) };

const centreOf = (quad: Quad) =>
  add(quad.origin, scale(add(quad.u, quad.v), 0.5));

const requireAt = <T>(items: readonly T[], index: number): T => {
  const value = items[index];
  if (value === undefined) throw new Error(`missing item at ${String(index)}`);
  return value;
};

describe("makeQuad", () => {
  it("derives the normal from the edge cross product", () => {
    const quad = makeQuad(
      vec3(0, 0, 0),
      vec3(0, 0, 1),
      vec3(1, 0, 0),
      NO_EMISSION,
    );
    expect(quad.normal).toEqual(vec3(0, 1, 0));
    expect(quad.area).toBeCloseTo(1);
  });

  // The shader inverts `p = a*u + b*v` with two independent projections, which
  // is only correct while the edges stay perpendicular.
  it("rejects non-perpendicular edges", () => {
    expect(() =>
      makeQuad(vec3(0, 0, 0), vec3(1, 0, 0), vec3(1, 1, 0), NO_EMISSION),
    ).toThrow("perpendicular");
  });
});

describe("makeBox", () => {
  const centre = vec3(0.4, 0.3, 0.5);
  const half = vec3(0.15, 0.3, 0.12);
  const faces = makeBox(centre, half, 23, NO_EMISSION);

  it("emits six faces", () => {
    expect(faces).toHaveLength(6);
  });

  it("orients every face outwards", () => {
    for (const face of faces) {
      expect(dot(face.normal, sub(centreOf(face), centre))).toBeGreaterThan(0);
    }
  });

  it("keeps every corner on the box surface", () => {
    for (const face of faces) {
      for (const corner of quadCorners(face)) {
        const offset = sub(corner, centre);
        const radius = Math.hypot(half.x, half.y, half.z);
        expect(length(offset)).toBeLessThanOrEqual(radius + 1e-6);
      }
    }
  });
});

describe("buildScene", () => {
  it("closes the room with inward-facing walls", () => {
    const { quads, occluderCount } = buildScene("classic");
    const walls = quads.slice(occluderCount);
    expect(walls).toHaveLength(6);
    const interior = vec3(0.5, 0.5, 0.5);
    for (const wall of walls) {
      expect(dot(wall.normal, sub(interior, centreOf(wall)))).toBeGreaterThan(
        0,
      );
    }
  });

  // `traceOccluded` stops at `occluderCount`, so anything a shadow ray must be
  // able to hit has to sort before the walls.
  it("sorts every occluder before the walls in both variants", () => {
    for (const variant of SCENE_VARIANTS) {
      const { quads, occluderCount, lights } = buildScene(variant);
      expect(occluderCount).toBe(quads.length - 6);
      for (const light of lights) {
        expect(light.quadIndex).toBeLessThan(occluderCount);
      }
      // The walls are the only unit-area quads, which is what separates them
      // from the blocks and emitters that a shadow ray still has to test.
      for (const wall of quads.slice(occluderCount)) {
        expect(wall.area).toBeCloseTo(1);
      }
      for (const occluder of quads.slice(0, occluderCount)) {
        expect(occluder.area).toBeLessThan(1);
        expect(isInsideRoom(centreOf(occluder), 0)).toBe(true);
      }
    }
  });

  it("puts a single emitter on the ceiling in the classic variant", () => {
    const scene = buildScene("classic");
    expect(scene.lights).toHaveLength(1);
    const light = requireAt(scene.quads, requireAt(scene.lights, 0).quadIndex);
    expect(light.normal.y).toBeCloseTo(-1);
    expect(isInsideRoom(centreOf(light), 0)).toBe(true);
  });

  it("normalises the light selection CDF", () => {
    const scene = buildScene("manyLights");
    expect(scene.lights.length).toBeGreaterThan(1);
    const total = scene.lights.reduce((sum, l) => sum + l.selectPdf, 0);
    expect(total).toBeCloseTo(1);
    expect(scene.lights.at(-1)?.cdf).toBe(1);

    let previous = 0;
    for (const light of scene.lights) {
      expect(light.cdf).toBeGreaterThanOrEqual(previous);
      previous = light.cdf;
    }
  });
});

describe("GPU packing", () => {
  const scene = buildScene("classic");

  it("matches the WGSL struct strides", () => {
    expect(packQuads(scene).byteLength).toBe(
      scene.quads.length * QUAD_STRIDE_BYTES,
    );
    expect(packLights(scene).byteLength).toBe(
      scene.lights.length * LIGHT_STRIDE_BYTES,
    );
  });

  it("writes quad fields at the offsets the shader reads", () => {
    const view = new DataView(packQuads(scene));
    const first = requireAt(scene.quads, 0);
    expect(view.getFloat32(0, true)).toBeCloseTo(first.origin.x);
    expect(view.getFloat32(12, true)).toBeCloseTo(first.area);
    expect(view.getFloat32(48, true)).toBeCloseTo(first.normal.x);
    expect(view.getFloat32(52, true)).toBeCloseTo(first.normal.y);
  });

  // `intersectQuad` multiplies by these instead of dividing by the edge lengths
  // it would otherwise recompute per ray. Dropping them here reads as a black
  // screen, not as a packing error.
  it("packs the inverse squared edge lengths into the u and v w lanes", () => {
    const view = new DataView(packQuads(scene));
    for (const [i, quad] of scene.quads.entries()) {
      const base = i * QUAD_STRIDE_BYTES;
      expect(view.getFloat32(base + 28, true)).toBeCloseTo(
        1 / dot(quad.u, quad.u),
      );
      expect(view.getFloat32(base + 44, true)).toBeCloseTo(
        1 / dot(quad.v, quad.v),
      );
    }
  });

  it("writes the light index as an unsigned integer", () => {
    const view = new DataView(packLights(scene));
    expect(view.getUint32(0, true)).toBe(requireAt(scene.lights, 0).quadIndex);
    expect(view.getFloat32(4, true)).toBeCloseTo(1);
  });
});
