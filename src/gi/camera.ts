import type { Vec3 } from "@/gi/math";
import { add, clamp, cross, dot, normalize, scale, sub, vec3 } from "@/gi/math";

/**
 * Orbit camera around a fixed target. Every scene is staged in the same closed
 * room, so the radius is clamped to keep the eye inside it.
 */
export type OrbitCamera = {
  readonly target: Vec3;
  readonly radius: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly fovY: number;
};

/** Orthonormal camera frame, laid out the way the shaders consume it. */
export type CameraBasis = {
  readonly pos: Vec3;
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly tanHalfFov: number;
  readonly aspect: number;
};

export const MIN_RADIUS = 0.15;
export const MAX_RADIUS = 3.5;
export const MAX_PITCH = (75 * Math.PI) / 180;

const WORLD_UP: Vec3 = vec3(0, 1, 0);

/**
 * Framing matches the canonical Cornell box: the eye sits outside the room and
 * the near wall is cut away by primary-ray back-face culling. The narrow field
 * of view keeps the frame inside the room's silhouette on a wide viewport.
 */
export const DEFAULT_CAMERA: OrbitCamera = {
  target: vec3(0.5, 0.5, 0.5),
  radius: 1.5,
  yaw: 0,
  pitch: 0,
  fovY: (29 * Math.PI) / 180,
};

export const cameraPosition = (camera: OrbitCamera): Vec3 => {
  const cosPitch = Math.cos(camera.pitch);
  return add(
    camera.target,
    scale(
      vec3(
        Math.sin(camera.yaw) * cosPitch,
        Math.sin(camera.pitch),
        Math.cos(camera.yaw) * cosPitch,
      ),
      camera.radius,
    ),
  );
};

/**
 * `fovY` frames the room on a viewport at least as wide as it is tall. Below
 * that, the horizontal half-extent (`tanHalfFov * aspect`) keeps shrinking with
 * the aspect ratio, which crops a phone's portrait view down to a patch of the
 * back wall. Widening the vertical field of view instead holds the horizontal
 * extent at its square-viewport value.
 */
const resolveTanHalfFov = (camera: OrbitCamera, aspect: number): number => {
  const tanHalf = Math.tan(camera.fovY / 2);
  return Number.isFinite(aspect) && aspect > 0 && aspect < 1
    ? tanHalf / aspect
    : tanHalf;
};

export const cameraBasis = (
  camera: OrbitCamera,
  aspect: number,
): CameraBasis => {
  const pos = cameraPosition(camera);
  const forward = normalize(sub(camera.target, pos));
  const right = normalize(cross(forward, WORLD_UP));
  const up = cross(right, forward);
  return {
    pos,
    forward,
    right,
    up,
    tanHalfFov: resolveTanHalfFov(camera, aspect),
    aspect,
  };
};

export const orbitCamera = (
  camera: OrbitCamera,
  deltaYaw: number,
  deltaPitch: number,
): OrbitCamera => ({
  ...camera,
  yaw: camera.yaw + deltaYaw,
  pitch: clamp(camera.pitch + deltaPitch, -MAX_PITCH, MAX_PITCH),
});

export const dollyCamera = (
  camera: OrbitCamera,
  factor: number,
): OrbitCamera => ({
  ...camera,
  radius: clamp(camera.radius * factor, MIN_RADIUS, MAX_RADIUS),
});

/** Mirrors `primaryRayDir` in common.wgsl. `ndc` is y-up, in [-1, 1]. */
export const primaryRayDirection = (
  basis: CameraBasis,
  ndcX: number,
  ndcY: number,
): Vec3 =>
  normalize(
    add(
      basis.forward,
      add(
        scale(basis.right, ndcX * basis.tanHalfFov * basis.aspect),
        scale(basis.up, ndcY * basis.tanHalfFov),
      ),
    ),
  );

export type Projection = {
  readonly u: number;
  readonly v: number;
  readonly inFrustum: boolean;
};

/** Mirrors `projectToUv` in common.wgsl. Returns top-left-origin screen UV. */
export const projectToUv = (basis: CameraBasis, point: Vec3): Projection => {
  const d = sub(point, basis.pos);
  const z = dot(d, basis.forward);
  if (z <= 1e-4) return { u: 0, v: 0, inFrustum: false };
  const x = dot(d, basis.right) / (z * basis.tanHalfFov * basis.aspect);
  const y = dot(d, basis.up) / (z * basis.tanHalfFov);
  return {
    u: x * 0.5 + 0.5,
    v: 0.5 - y * 0.5,
    inFrustum: Math.abs(x) <= 1 && Math.abs(y) <= 1,
  };
};
