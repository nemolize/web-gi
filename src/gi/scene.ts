import type { Vec3 } from "@/gi/math";
import {
  add,
  cross,
  degToRad,
  dot,
  length,
  normalize,
  rotateY,
  scale,
  sub,
  vec3,
} from "@/gi/math";

export type Material = {
  readonly albedo: Vec3;
  readonly emission: Vec3;
};

/**
 * Parallelogram primitive. Edges are required to be perpendicular so the
 * shader can invert `p = a*u + b*v` with two dot products instead of solving a
 * 2x2 system, and so `area` is simply `|u| * |v|`.
 */
export type Quad = {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly normal: Vec3;
  readonly area: number;
  readonly material: Material;
};

export type LightRef = {
  readonly quadIndex: number;
  /** Selection probability, proportional to emitted power. */
  readonly selectPdf: number;
  /** Inclusive prefix sum of `selectPdf`; the last entry is 1. */
  readonly cdf: number;
};

/**
 * A bounded run of occluder quads. A shadow ray that misses the bound skips
 * every quad inside it, which is exact because the bound contains them all.
 */
export type OccluderCluster = {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly start: number;
  readonly count: number;
};

export type Scene = {
  /** Occluders first, then the room walls; see `occluderCount`. */
  readonly quads: readonly Quad[];
  readonly lights: readonly LightRef[];
  /**
   * Quads a shadow ray has to test. The room is convex and every shadow ray is
   * a segment between two points on its interior surfaces, so no wall can lie
   * across one — the walls sort last and `traceOccluded` stops before them.
   */
  readonly occluderCount: number;
  /** Covers exactly `quads[0 .. occluderCount)`, one entry per group. */
  readonly occluderClusters: readonly OccluderCluster[];
};

export const SCENE_VARIANTS = ["classic", "manyLights"] as const;
export type SceneVariant = (typeof SCENE_VARIANTS)[number];

export const QUAD_STRIDE_BYTES = 96;
export const LIGHT_STRIDE_BYTES = 16;
export const CLUSTER_STRIDE_BYTES = 32;

const PERPENDICULAR_TOLERANCE = 1e-6;

export const makeQuad = (
  origin: Vec3,
  u: Vec3,
  v: Vec3,
  material: Material,
): Quad => {
  const lu = length(u);
  const lv = length(v);
  if (Math.abs(dot(u, v)) > PERPENDICULAR_TOLERANCE * lu * lv) {
    throw new Error("Quad edges must be perpendicular");
  }
  return {
    origin,
    u,
    v,
    normal: normalize(cross(u, v)),
    area: lu * lv,
    material,
  };
};

const WHITE: Material = {
  albedo: vec3(0.725, 0.71, 0.68),
  emission: vec3(0, 0, 0),
};
const RED: Material = {
  albedo: vec3(0.63, 0.065, 0.05),
  emission: vec3(0, 0, 0),
};
const GREEN: Material = {
  albedo: vec3(0.14, 0.45, 0.091),
  emission: vec3(0, 0, 0),
};

const emitter = (emission: Vec3): Material => ({
  albedo: vec3(0, 0, 0),
  emission,
});

/** Six outward-facing faces of a box rotated about its own Y axis. */
export const makeBox = (
  center: Vec3,
  halfSize: Vec3,
  rotationYDeg: number,
  material: Material,
): Quad[] => {
  const angle = degToRad(rotationYDeg);
  const ex = scale(rotateY(vec3(1, 0, 0), angle), halfSize.x);
  const ey = scale(vec3(0, 1, 0), halfSize.y);
  const ez = scale(rotateY(vec3(0, 0, 1), angle), halfSize.z);
  const corner = (sx: number, sy: number, sz: number): Vec3 =>
    add(center, add(add(scale(ex, sx), scale(ey, sy)), scale(ez, sz)));
  const two = (a: Vec3): Vec3 => scale(a, 2);

  return [
    // +X / -X
    makeQuad(corner(1, -1, -1), two(ey), two(ez), material),
    makeQuad(corner(-1, -1, -1), two(ez), two(ey), material),
    // +Y / -Y
    makeQuad(corner(-1, 1, -1), two(ez), two(ex), material),
    makeQuad(corner(-1, -1, -1), two(ex), two(ez), material),
    // +Z / -Z
    makeQuad(corner(-1, -1, 1), two(ex), two(ey), material),
    makeQuad(corner(-1, -1, -1), two(ey), two(ex), material),
  ];
};

const room = (): Quad[] => [
  // floor, ceiling, back, front (behind the eye), left (red), right (green)
  makeQuad(vec3(0, 0, 0), vec3(0, 0, 1), vec3(1, 0, 0), WHITE),
  makeQuad(vec3(0, 1, 0), vec3(1, 0, 0), vec3(0, 0, 1), WHITE),
  makeQuad(vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), WHITE),
  makeQuad(vec3(0, 0, 1), vec3(0, 1, 0), vec3(1, 0, 0), WHITE),
  makeQuad(vec3(0, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), RED),
  makeQuad(vec3(1, 0, 0), vec3(0, 0, 1), vec3(0, 1, 0), GREEN),
];

/** One group per box, so each keeps its own bound in `occluderClusters`. */
const blocks = (): Quad[][] => [
  makeBox(vec3(0.33, 0.33, 0.34), vec3(0.145, 0.33, 0.145), 17, WHITE),
  makeBox(vec3(0.66, 0.165, 0.66), vec3(0.15, 0.165, 0.15), -17, WHITE),
];

const classicLight = (): Quad[] => [
  makeQuad(
    vec3(0.35, 0.998, 0.36),
    vec3(0.3, 0, 0),
    vec3(0, 0, 0.28),
    emitter(vec3(18, 15, 10)),
  ),
];

/**
 * A grid of small, differently tinted ceiling emitters. Many-light scenes are
 * where ReSTIR DI's resampling pays off, so this variant makes the difference
 * between "8 candidates" and "8 candidates + reuse" visible.
 */
const manyLights = (): Quad[] => {
  const quads: Quad[] = [];
  const gridX = 6;
  const gridZ = 5;
  const size = 0.05;
  for (let iz = 0; iz < gridZ; iz++) {
    for (let ix = 0; ix < gridX; ix++) {
      const hue = (ix + iz * gridX) / (gridX * gridZ);
      const tint = vec3(
        0.6 + 0.4 * Math.cos(2 * Math.PI * hue),
        0.6 + 0.4 * Math.cos(2 * Math.PI * (hue + 1 / 3)),
        0.6 + 0.4 * Math.cos(2 * Math.PI * (hue + 2 / 3)),
      );
      quads.push(
        makeQuad(
          vec3(0.12 + ix * 0.13, 0.998, 0.14 + iz * 0.15),
          vec3(size, 0, 0),
          vec3(0, 0, size),
          // Tuned so total emitted power roughly matches the classic variant.
          emitter(scale(tint, 26)),
        ),
      );
    }
  }
  return quads;
};

const LUMINANCE = vec3(0.2126, 0.7152, 0.0722);

const collectLights = (quads: readonly Quad[]): LightRef[] => {
  const powers = quads.map((quad, quadIndex) => ({
    quadIndex,
    power: dot(quad.material.emission, LUMINANCE) * quad.area * Math.PI,
  }));
  const emissive = powers.filter((entry) => entry.power > 0);
  const total = emissive.reduce((sum, entry) => sum + entry.power, 0);
  if (total <= 0) return [];

  let running = 0;
  return emissive.map((entry, index) => {
    const selectPdf = entry.power / total;
    running += selectPdf;
    return {
      quadIndex: entry.quadIndex,
      selectPdf,
      // Guard against float drift so the last CDF entry is exactly 1.
      cdf: index === emissive.length - 1 ? 1 : running,
    };
  });
};

const clusterOf = (group: readonly Quad[], start: number): OccluderCluster => {
  const corners = group.flatMap(quadCorners);
  const reduce = (pick: (a: number, b: number) => number): Vec3 =>
    corners.reduce(
      (acc, c) => vec3(pick(acc.x, c.x), pick(acc.y, c.y), pick(acc.z, c.z)),
      corners[0] ?? vec3(0, 0, 0),
    );
  return {
    min: reduce(Math.min),
    max: reduce(Math.max),
    start,
    count: group.length,
  };
};

export const buildScene = (variant: SceneVariant): Scene => {
  // Emitters share one group: they are a single ceiling patch, so one bound
  // rejects all of them for any ray that stays below it.
  const groups: Quad[][] = [
    ...blocks(),
    variant === "manyLights" ? manyLights() : classicLight(),
  ];
  const occluders = groups.flat();
  const quads = [...occluders, ...room()];

  let start = 0;
  const occluderClusters = groups.map((group) => {
    const cluster = clusterOf(group, start);
    start += group.length;
    return cluster;
  });

  return {
    quads,
    lights: collectLights(quads),
    occluderCount: occluders.length,
    occluderClusters,
  };
};

export const packQuads = (scene: Scene): ArrayBuffer => {
  const buffer = new ArrayBuffer(scene.quads.length * QUAD_STRIDE_BYTES);
  const f32 = new Float32Array(buffer);
  scene.quads.forEach((quad, i) => {
    const base = (i * QUAD_STRIDE_BYTES) / 4;
    const write = (offset: number, v: Vec3, w: number): void => {
      f32[base + offset] = v.x;
      f32[base + offset + 1] = v.y;
      f32[base + offset + 2] = v.z;
      f32[base + offset + 3] = w;
    };
    write(0, quad.origin, quad.area);
    // Inverse squared edge lengths: `intersectQuad` needs them on every
    // ray/quad test, and the edges never change once packed.
    write(4, quad.u, 1 / dot(quad.u, quad.u));
    write(8, quad.v, 1 / dot(quad.v, quad.v));
    write(12, quad.normal, 0);
    write(16, quad.material.albedo, 0);
    write(20, quad.material.emission, 0);
  });
  return buffer;
};

export const packClusters = (scene: Scene): ArrayBuffer => {
  const buffer = new ArrayBuffer(
    Math.max(scene.occluderClusters.length, 1) * CLUSTER_STRIDE_BYTES,
  );
  const f32 = new Float32Array(buffer);
  scene.occluderClusters.forEach((cluster, i) => {
    const base = (i * CLUSTER_STRIDE_BYTES) / 4;
    // Counts ride in the w lanes as floats: small integers are exact, and the
    // vec4 layout is what every other GPU struct here uses.
    f32.set([cluster.min.x, cluster.min.y, cluster.min.z, cluster.start], base);
    f32.set(
      [cluster.max.x, cluster.max.y, cluster.max.z, cluster.count],
      base + 4,
    );
  });
  return buffer;
};

export const packLights = (scene: Scene): ArrayBuffer => {
  const buffer = new ArrayBuffer(
    Math.max(scene.lights.length, 1) * LIGHT_STRIDE_BYTES,
  );
  const view = new DataView(buffer);
  scene.lights.forEach((light, i) => {
    const base = i * LIGHT_STRIDE_BYTES;
    view.setUint32(base, light.quadIndex, true);
    view.setFloat32(base + 4, light.cdf, true);
    view.setFloat32(base + 8, light.selectPdf, true);
  });
  return buffer;
};

/** Distance from the box centre to the nearest interior wall, for camera clamping. */
export const sceneBounds = { min: vec3(0, 0, 0), max: vec3(1, 1, 1) } as const;

export const isInsideRoom = (point: Vec3, margin: number): boolean => {
  const lo = add(sceneBounds.min, vec3(margin, margin, margin));
  const hi = sub(sceneBounds.max, vec3(margin, margin, margin));
  return (
    point.x >= lo.x &&
    point.y >= lo.y &&
    point.z >= lo.z &&
    point.x <= hi.x &&
    point.y <= hi.y &&
    point.z <= hi.z
  );
};

export const quadCorners = (quad: Quad): Vec3[] => [
  quad.origin,
  add(quad.origin, quad.u),
  add(quad.origin, add(quad.u, quad.v)),
  add(quad.origin, quad.v),
];
