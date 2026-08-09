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
 * A bounded run of quads. A ray that misses the bound skips every quad inside
 * it, which is exact because the bound contains them all.
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
  /** Covers every quad, one entry per group, occluder groups first. */
  readonly clusters: readonly OccluderCluster[];
  /** `clusters[0 .. occluderClusterCount)` are the ones a shadow ray tests. */
  readonly occluderClusterCount: number;
};

export const SCENE_VARIANTS = [
  "classic",
  "manyLights",
  "doorway",
  "cove",
  "pillars",
] as const;
export type SceneVariant = (typeof SCENE_VARIANTS)[number];

export const SCENE_LABELS: Record<SceneVariant, string> = {
  classic: "Cornell box",
  manyLights: "30 lights",
  doorway: "Two rooms",
  cove: "Cove light",
  pillars: "Pillars",
};

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

const diffuse = (albedo: Vec3): Material => ({
  albedo,
  emission: vec3(0, 0, 0),
});

const WHITE = diffuse(vec3(0.725, 0.71, 0.68));
const RED = diffuse(vec3(0.63, 0.065, 0.05));
const GREEN = diffuse(vec3(0.14, 0.45, 0.091));
const SLATE = diffuse(vec3(0.32, 0.34, 0.38));
const AMBER = diffuse(vec3(0.62, 0.4, 0.16));
const TEAL = diffuse(vec3(0.13, 0.4, 0.42));

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

/**
 * `occluderGroups` is one entry per cluster bound; the walls trail as a single
 * group, since a closest-hit ray almost always reaches one of them.
 */
type SceneDefinition = {
  readonly occluderGroups: readonly (readonly Quad[])[];
  readonly walls: readonly Quad[];
};

type Walls = {
  readonly floor: Material;
  readonly ceiling: Material;
  readonly back: Material;
  /** Behind the eye; primary rays cull it, bounces still light off it. */
  readonly front: Material;
  readonly left: Material;
  readonly right: Material;
};

/**
 * The six inward-facing faces of the unit cube every variant is staged in.
 * Keeping the shell identical is what lets `sceneBounds`, the camera clamp and
 * the shadow-ray shortcut hold for all of them.
 */
const room = (walls: Partial<Walls> = {}): Quad[] => {
  const m: Walls = {
    floor: WHITE,
    ceiling: WHITE,
    back: WHITE,
    front: WHITE,
    left: WHITE,
    right: WHITE,
    ...walls,
  };
  return [
    makeQuad(vec3(0, 0, 0), vec3(0, 0, 1), vec3(1, 0, 0), m.floor),
    makeQuad(vec3(0, 1, 0), vec3(1, 0, 0), vec3(0, 0, 1), m.ceiling),
    makeQuad(vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), m.back),
    makeQuad(vec3(0, 0, 1), vec3(0, 1, 0), vec3(1, 0, 0), m.front),
    makeQuad(vec3(0, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), m.left),
    makeQuad(vec3(1, 0, 0), vec3(0, 0, 1), vec3(0, 1, 0), m.right),
  ];
};

/** One group per box, so each keeps its own bound in `clusters`. */
const blocks = (): Quad[][] => [
  makeBox(vec3(0.33, 0.33, 0.34), vec3(0.145, 0.33, 0.145), 17, WHITE),
  makeBox(vec3(0.66, 0.165, 0.66), vec3(0.15, 0.165, 0.15), -17, WHITE),
];

/** Axis-aligned box spanning two opposite corners. */
const boxBetween = (min: Vec3, max: Vec3, material: Material): Quad[] =>
  makeBox(scale(add(min, max), 0.5), scale(sub(max, min), 0.5), 0, material);

/** Emissive patch just under the ceiling, facing down. */
const ceilingLight = (
  x: readonly [number, number],
  z: readonly [number, number],
  emission: Vec3,
): Quad =>
  makeQuad(
    vec3(x[0], 0.998, z[0]),
    vec3(x[1] - x[0], 0, 0),
    vec3(0, 0, z[1] - z[0]),
    emitter(emission),
  );

const classicLight = (): Quad[] => [
  ceilingLight([0.35, 0.65], [0.36, 0.64], vec3(18, 15, 10)),
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
      const x = 0.12 + ix * 0.13;
      const z = 0.14 + iz * 0.15;
      quads.push(
        // Tuned so total emitted power roughly matches the classic variant.
        ceilingLight([x, x + size], [z, z + size], scale(tint, 26)),
      );
    }
  }
  return quads;
};

/**
 * A partition with a single doorway. Only one half is lit directly, so in the
 * other the indirect term is the whole image rather than a tint on top of one.
 */
const doorway = (): SceneDefinition => ({
  occluderGroups: [
    // The partition is one group: a thin slab bounds all three pieces, so a ray
    // that stays on one side of it skips them together. It faces the default
    // camera, which puts the doorway and the dark half in the same frame.
    [
      ...boxBetween(vec3(0, 0, 0.485), vec3(0.55, 1, 0.515), WHITE),
      ...boxBetween(vec3(0.85, 0, 0.485), vec3(1, 1, 0.515), WHITE),
      ...boxBetween(vec3(0.55, 0.62, 0.485), vec3(0.85, 1, 0.515), WHITE),
    ],
    makeBox(vec3(0.33, 0.18, 0.72), vec3(0.13, 0.18, 0.13), 25, WHITE),
    [ceilingLight([0.15, 0.45], [0.14, 0.42], vec3(30, 26, 20))],
  ],
  // Only the lit half sees the amber wall, so the colour reaching the dark half
  // has bounced at least twice.
  walls: room({ back: AMBER }),
});

/**
 * Cove lighting: the emitter faces the ceiling from behind a lip, so nothing on
 * screen is lit directly and the image is one bounce off the ceiling.
 */
const cove = (): SceneDefinition => ({
  occluderGroups: [
    // Shelf and lip are one fixture; a single bound covers both.
    [
      ...boxBetween(vec3(0.16, 0.6, 0.04), vec3(0.84, 0.64, 0.2), WHITE),
      ...boxBetween(vec3(0.16, 0.64, 0.19), vec3(0.84, 0.76, 0.2), WHITE),
    ],
    makeBox(vec3(0.32, 0.26, 0.55), vec3(0.1, 0.26, 0.1), 14, WHITE),
    makeBox(vec3(0.68, 0.15, 0.42), vec3(0.12, 0.15, 0.12), -22, WHITE),
    [
      // Faces up: `u x v` is +Y, and a downward-looking ray is culled by the
      // primary trace, which is what keeps the emitter itself off screen.
      makeQuad(
        vec3(0.2, 0.645, 0.05),
        vec3(0, 0, 0.13),
        vec3(0.6, 0, 0),
        // Roughly twice the classic emitter's power: everything the eye sees
        // has lost an albedo factor on the ceiling first.
        emitter(vec3(34, 31, 25)),
      ),
    ],
  ],
  walls: room({ front: AMBER, floor: SLATE }),
});

/** Height of each pillar in the 3x3 grid, row-major from the back-left. */
const PILLAR_HEIGHTS = [0.42, 0.22, 0.34, 0.18, 0.5, 0.26, 0.3, 0.44, 0.2];

/**
 * A grid of pillars under one broad ceiling emitter: overlapping penumbrae and
 * pillar-to-floor contact are where spatial reuse and the a-trous filter smear.
 */
const pillars = (): SceneDefinition => ({
  occluderGroups: [
    ...PILLAR_HEIGHTS.map((height, index) =>
      makeBox(
        vec3(
          0.22 + (index % 3) * 0.28,
          height / 2,
          0.22 + Math.floor(index / 3) * 0.28,
        ),
        vec3(0.07, height / 2, 0.07),
        index * 12,
        WHITE,
      ),
    ),
    [ceilingLight([0.2, 0.8], [0.2, 0.8], vec3(5, 4.6, 3.9))],
  ],
  walls: room({ floor: SLATE, back: TEAL }),
});

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

// Quads that move together share a group, so one bound rejects the run: a
// variant's emitters, the pieces of one partition, the six faces of one box.
const SCENE_DEFINITIONS: Record<SceneVariant, () => SceneDefinition> = {
  classic: () => ({
    occluderGroups: [...blocks(), classicLight()],
    walls: room({ left: RED, right: GREEN }),
  }),
  manyLights: () => ({
    occluderGroups: [...blocks(), manyLights()],
    walls: room({ left: RED, right: GREEN }),
  }),
  doorway,
  cove,
  pillars,
};

export const buildScene = (variant: SceneVariant): Scene => {
  const { occluderGroups, walls } = SCENE_DEFINITIONS[variant]();
  const groups = [...occluderGroups, walls];
  const quads = groups.flat();

  let start = 0;
  const clusters = groups.map((group) => {
    const cluster = clusterOf(group, start);
    start += group.length;
    return cluster;
  });

  return {
    quads,
    lights: collectLights(quads),
    occluderCount: occluderGroups.flat().length,
    clusters,
    occluderClusterCount: occluderGroups.length,
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
    Math.max(scene.clusters.length, 1) * CLUSTER_STRIDE_BYTES,
  );
  const f32 = new Float32Array(buffer);
  scene.clusters.forEach((cluster, i) => {
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
