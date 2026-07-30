export type Vec3 = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.x + b.x, a.y + b.y, a.z + b.z);

export const sub = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.x - b.x, a.y - b.y, a.z - b.z);

export const mul = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.x * b.x, a.y * b.y, a.z * b.z);

export const scale = (a: Vec3, s: number): Vec3 =>
  vec3(a.x * s, a.y * s, a.z * s);

export const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

export const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len > 0 ? scale(a, 1 / len) : vec3(0, 0, 0);
};

export const rotateY = (a: Vec3, radians: number): Vec3 => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return vec3(a.x * c + a.z * s, a.y, -a.x * s + a.z * c);
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;
