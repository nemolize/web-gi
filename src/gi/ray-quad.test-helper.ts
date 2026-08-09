import type { Vec3 } from "@/gi/math";
import { add, dot, scale, sub } from "@/gi/math";
import type { Quad } from "@/gi/scene";

const RAY_EPS = 1e-4;

/**
 * Mirrors `intersectQuad` in `scene.wgsl`. Tests that assert what a ray can
 * reach have to agree with the shader, so the traversal invariants and the
 * scene-layout checks share this one copy of it.
 */
export const intersectQuad = (
  q: Quad,
  ro: Vec3,
  rd: Vec3,
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
