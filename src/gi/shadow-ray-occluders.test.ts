// `traceOccluded` only walks the occluders, on the grounds that a segment
// between two points on the room's interior surfaces can never reach a wall.
// That holds because the room is the convex hull of the scene — a property of
// the scene data, not of the shader, so it is checked here rather than assumed.
import { add, dot, normalize, scale, sub } from "@/gi/math";
import type { Quad } from "@/gi/scene";
import { buildScene, SCENE_VARIANTS, sceneBounds } from "@/gi/scene";

const RAY_EPS = 1e-4;
const SURFACE_EPS = 1e-3;
const SEGMENTS = 200_000;

/** Mirrors `intersectQuad` in `scene.wgsl`. */
const intersectQuad = (
  q: Quad,
  ro: { x: number; y: number; z: number },
  rd: { x: number; y: number; z: number },
  tMax: number,
): number => {
  const denom = dot(q.normal, rd);
  if (Math.abs(denom) < 1e-9) return -1;
  const t = dot(q.normal, sub(q.origin, ro)) / denom;
  if (t <= RAY_EPS || t >= tMax) return -1;
  const p = sub(add(ro, scale(rd, t)), q.origin);
  const a = dot(p, q.u) / dot(q.u, q.u);
  if (a < 0 || a > 1) return -1;
  const b = dot(p, q.v) / dot(q.v, q.v);
  if (b < 0 || b > 1) return -1;
  return t;
};

/** Fixed sequence so a counter-example is reproducible from the seed. */
const lcg = (state: number) => () => {
  state = (state * 1103515245 + 12345) & 0x7fffffff;
  return state / 0x7fffffff;
};

describe("shadow-ray wall exclusion", () => {
  it.each([...SCENE_VARIANTS])(
    "never lets a wall block a surface-to-surface segment (%s)",
    (variant) => {
      const { quads, occluderCount } = buildScene(variant);
      const walls = quads.slice(occluderCount);
      const rnd = lcg(123456789);
      // A ray can only leave a face whose outward normal points into the room;
      // the block faces lying flat on the floor are unreachable.
      const reachable = quads.filter((q) => {
        const centre = add(q.origin, scale(add(q.u, q.v), 0.5));
        const lifted = add(centre, scale(q.normal, SURFACE_EPS));
        return (
          lifted.x > 0 &&
          lifted.x < 1 &&
          lifted.y > 0 &&
          lifted.y < 1 &&
          lifted.z > 0 &&
          lifted.z < 1
        );
      });
      const pointOn = (q: Quad) =>
        add(q.origin, add(scale(q.u, rnd()), scale(q.v, rnd())));
      const pick = () => {
        const quad = reachable[Math.floor(rnd() * reachable.length)];
        if (quad === undefined) throw new Error("no reachable faces");
        return quad;
      };

      // Counted rather than asserted per wall: 1.2M assertions time out, and
      // the first counter-example is what the failure needs to report anyway.
      let tested = 0;
      let blocked: string | null = null;
      for (let i = 0; i < SEGMENTS; i++) {
        const from = pick();
        const origin = add(pointOn(from), scale(from.normal, SURFACE_EPS));
        const destination = pointOn(pick());
        const delta = sub(destination, origin);
        const distance = Math.hypot(delta.x, delta.y, delta.z);
        const tMax = distance - 2 * SURFACE_EPS;
        if (distance < 1e-5 || tMax <= RAY_EPS) continue;
        const direction = normalize(delta);
        tested++;
        for (const wall of walls) {
          if (
            intersectQuad(wall, origin, direction, tMax) > 0 &&
            blocked === null
          ) {
            blocked = `${JSON.stringify(origin)} -> ${JSON.stringify(destination)}`;
          }
        }
      }
      expect(blocked).toBeNull();
      expect(tested).toBeGreaterThan(SEGMENTS / 2);
    },
  );

  it.each([...SCENE_VARIANTS])(
    "keeps every quad inside the room, which is what makes it convex (%s)",
    (variant) => {
      for (const quad of buildScene(variant).quads) {
        for (const corner of [
          quad.origin,
          add(quad.origin, quad.u),
          add(quad.origin, quad.v),
          add(quad.origin, add(quad.u, quad.v)),
        ]) {
          for (const axis of ["x", "y", "z"] as const) {
            expect(corner[axis]).toBeGreaterThanOrEqual(
              sceneBounds.min[axis] - 1e-9,
            );
            expect(corner[axis]).toBeLessThanOrEqual(
              sceneBounds.max[axis] + 1e-9,
            );
          }
        }
      }
    },
  );
});
