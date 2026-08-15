import type { Vec3 } from "@/gi/math";
import { add, dot, length, scale, sub, vec3 } from "@/gi/math";
import { intersectQuad } from "@/gi/ray-quad.test-helper";
import type { Quad } from "@/gi/scene";
import {
  buildScene,
  CLUSTER_STRIDE_BYTES,
  GLASS_SHAPE_STRIDE_BYTES,
  isInsideRoom,
  LIGHT_STRIDE_BYTES,
  makeBox,
  makeQuad,
  packClusters,
  packGlassShapes,
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
  it("sorts every occluder before the walls in every variant", () => {
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

  it("lights every variant", () => {
    for (const variant of SCENE_VARIANTS) {
      expect(buildScene(variant).lights.length).toBeGreaterThan(0);
    }
  });

  it("stages clear dielectric sphere and boxes inside the glass scene", () => {
    const scene = buildScene("glassShapes");
    expect(scene.glassShapes).toHaveLength(3);
    const sphere = requireAt(scene.glassShapes, 0);
    const pedestalBox = requireAt(scene.glassShapes, 1);
    const backdropBox = requireAt(scene.glassShapes, 2);
    if (
      sphere.kind !== "sphere" ||
      pedestalBox.kind !== "box" ||
      backdropBox.kind !== "box"
    ) {
      throw new Error("Glass scene must contain the sphere and both boxes");
    }
    expect(sphere.ior).toBeCloseTo(1.52);
    expect(sphere.tint.x).toBeGreaterThan(0.9);
    expect(backdropBox.center).toEqual(vec3(0.5, 0.35, 0.12));
    expect(backdropBox.halfExtents).toEqual(vec3(0.08, 0.34, 0.035));
    expect(backdropBox.tint).toEqual(vec3(1, 1, 1));
    expect(backdropBox.ior).toBeCloseTo(1.52);
    const boxes = [pedestalBox, backdropBox];
    for (const axis of ["x", "y", "z"] as const) {
      expect(sphere.center[axis] - sphere.radius).toBeGreaterThanOrEqual(0);
      expect(sphere.center[axis] + sphere.radius).toBeLessThanOrEqual(1);
      for (const box of boxes) {
        expect(box.center[axis] - box.halfExtents[axis]).toBeGreaterThanOrEqual(
          0,
        );
        expect(box.center[axis] + box.halfExtents[axis]).toBeLessThanOrEqual(1);
      }
    }
    const pedestalTop = Math.max(
      ...scene.quads
        .slice(0, 6)
        .flatMap(quadCorners)
        .map((corner) => corner.y),
    );
    expect(
      pedestalBox.center.y - pedestalBox.halfExtents.y - pedestalTop,
    ).toBeGreaterThan(0.005);
    expect(backdropBox.center.y - backdropBox.halfExtents.y).toBeGreaterThan(
      0.005,
    );
    for (const variant of SCENE_VARIANTS.filter(
      (candidate) => candidate !== "glassShapes",
    )) {
      expect(buildScene(variant).glassShapes).toEqual([]);
    }
  });

  // The cove emitter is the one that does not face the room: it points at the
  // ceiling, and a flipped normal would light nothing a shadow ray can reach.
  it("aims the cove emitter at the ceiling", () => {
    const scene = buildScene("cove");
    expect(scene.lights).toHaveLength(1);
    const light = requireAt(scene.quads, requireAt(scene.lights, 0).quadIndex);
    expect(light.normal.y).toBeCloseTo(1);
    expect(light.origin.y).toBeLessThan(0.7);
  });

  it("blocks the doorway partition everywhere but the opening", () => {
    const { quads, occluderCount } = buildScene("doorway");
    const occluders = quads.slice(0, occluderCount);
    const crosses = (from: Vec3, to: Vec3): boolean => {
      const delta = sub(to, from);
      const distance = length(delta);
      const direction = scale(delta, 1 / distance);
      return !occluders.some(
        (quad) => intersectQuad(quad, from, direction, distance) > 0,
      );
    };
    expect(crosses(vec3(0.7, 0.3, 0.25), vec3(0.7, 0.3, 0.8))).toBe(true);
    expect(crosses(vec3(0.2, 0.3, 0.25), vec3(0.2, 0.3, 0.8))).toBe(false);
    expect(crosses(vec3(0.7, 0.85, 0.25), vec3(0.7, 0.85, 0.8))).toBe(false);
  });

  it("puts a single emitter on the ceiling in the classic variant", () => {
    const scene = buildScene("classic");
    expect(scene.lights).toHaveLength(1);
    const light = requireAt(scene.quads, requireAt(scene.lights, 0).quadIndex);
    expect(light.normal.y).toBeCloseTo(-1);
    expect(isInsideRoom(centreOf(light), 0)).toBe(true);
  });

  // `pickLight` in scene.wgsl binary-searches this CDF instead of scanning it,
  // which only agrees with the scan while the CDF stays non-decreasing.
  it("picks the same light by binary search as by a front-to-back scan", () => {
    const { lights } = buildScene("manyLights");
    const scan = (u: number) =>
      lights.findIndex((l) => u < l.cdf) === -1
        ? lights.length - 1
        : lights.findIndex((l) => u < l.cdf);
    const search = (u: number) => {
      let lo = 0;
      let hi = lights.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (u < requireAt(lights, mid).cdf) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const probes = [0, 1, ...lights.flatMap((l) => [l.cdf, l.cdf - 1e-7])];
    for (let i = 0; i < 2000; i++) probes.push(i / 2000);
    for (const u of probes) expect(search(u)).toBe(scan(u));
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

  it("writes glass shape fields at the offsets the shader reads", () => {
    const glassScene = buildScene("glassShapes");
    const sphere = requireAt(glassScene.glassShapes, 0);
    const box = requireAt(glassScene.glassShapes, 1);
    const backdropBox = requireAt(glassScene.glassShapes, 2);
    if (
      sphere.kind !== "sphere" ||
      box.kind !== "box" ||
      backdropBox.kind !== "box"
    ) {
      throw new Error("Glass shapes are not staged in the expected order");
    }
    const view = new DataView(packGlassShapes(glassScene));
    expect(view.byteLength).toBe(GLASS_SHAPE_STRIDE_BYTES * 3);
    expect(view.getFloat32(0, true)).toBeCloseTo(sphere.center.x);
    expect(view.getFloat32(12, true)).toBe(0);
    expect(view.getFloat32(28, true)).toBeCloseTo(sphere.radius);
    expect(view.getFloat32(32, true)).toBeCloseTo(sphere.tint.x);
    expect(view.getFloat32(44, true)).toBeCloseTo(sphere.ior);
    expect(view.getFloat32(60, true)).toBe(1);
    expect(view.getFloat32(64, true)).toBeCloseTo(box.halfExtents.x);
    expect(view.getFloat32(92, true)).toBeCloseTo(box.ior);
    expect(view.getFloat32(108, true)).toBe(1);
    expect(view.getFloat32(128, true)).toBeCloseTo(backdropBox.tint.x);
    expect(view.getFloat32(140, true)).toBeCloseTo(backdropBox.ior);
    expect(packGlassShapes(scene).byteLength).toBe(GLASS_SHAPE_STRIDE_BYTES);
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

  // Both traversals skip a cluster's whole run when they miss its bound, so the
  // bound containing every corner is what keeps that skip exact.
  it("bounds every quad inside its cluster and covers them all", () => {
    for (const variant of SCENE_VARIANTS) {
      const { quads, clusters } = buildScene(variant);
      let expectedStart = 0;
      for (const cluster of clusters) {
        expect(cluster.start).toBe(expectedStart);
        expect(cluster.count).toBeGreaterThan(0);
        for (const quad of quads.slice(
          cluster.start,
          cluster.start + cluster.count,
        )) {
          for (const corner of quadCorners(quad)) {
            for (const axis of ["x", "y", "z"] as const) {
              expect(corner[axis]).toBeGreaterThanOrEqual(cluster.min[axis]);
              expect(corner[axis]).toBeLessThanOrEqual(cluster.max[axis]);
            }
          }
        }
        expectedStart += cluster.count;
      }
      expect(expectedStart).toBe(quads.length);
    }
  });

  it("packs cluster bounds and runs at the offsets the shader reads", () => {
    const scene = buildScene("manyLights");
    const view = new DataView(packClusters(scene));
    expect(view.byteLength).toBe(scene.clusters.length * CLUSTER_STRIDE_BYTES);
    scene.clusters.forEach((cluster, i) => {
      const base = i * CLUSTER_STRIDE_BYTES;
      expect(view.getFloat32(base, true)).toBeCloseTo(cluster.min.x);
      expect(view.getFloat32(base + 12, true)).toBe(cluster.start);
      expect(view.getFloat32(base + 16, true)).toBeCloseTo(cluster.max.x);
      expect(view.getFloat32(base + 28, true)).toBe(cluster.count);
    });
  });

  it("writes the light index as an unsigned integer", () => {
    const view = new DataView(packLights(scene));
    expect(view.getUint32(0, true)).toBe(requireAt(scene.lights, 0).quadIndex);
    expect(view.getFloat32(4, true)).toBeCloseTo(1);
  });
});
