// Shared constants, data layouts, RNG and sampling helpers.
// This file declares no bindings so it can be prepended to every shader,
// including the ones that never touch the scene buffers.

const PI: f32 = 3.14159265359;
const INV_PI: f32 = 0.31830988618;
const RAY_EPS: f32 = 1e-4;
const SURFACE_EPS: f32 = 1e-3;
const T_FAR: f32 = 1e20;
/** Firefly guard; generous enough that it never clips the lit floor. */
const MAX_ILLUMINATION: f32 = 200.0;

/**
 * vec4f throughout: a `vec3f` followed by a scalar packs that scalar into the
 * vec3's padding word, and drivers disagree on the resulting offsets (an Adreno
 * device read `forward` as `up`). Byte layout matches the packed form, so the
 * CPU-side writer is unchanged.
 */
struct Camera {
  pos: vec4f,     // xyz = eye position, w = tanHalfFov
  right: vec4f,   // xyz = right axis,   w = aspect
  up: vec4f,      // xyz = up axis
  forward: vec4f, // xyz = forward axis
}

fn camTanHalfFov(cam: Camera) -> f32 {
  return cam.pos.w;
}

fn camAspect(cam: Camera) -> f32 {
  return cam.right.w;
}

struct Uniforms {
  cam: Camera,
  prevCam: Camera,
  resolution: vec2u,
  frame: u32,
  accumFrames: u32,
  quadCount: u32,
  lightCount: u32,
  diCandidates: u32,
  spatialSamples: u32,
  maxBounces: u32,
  maxHistory: u32,
  flags: u32,
  spatialRadius: f32,
  exposure: f32,
  clusterCount: u32,
  occluderClusterCount: u32,
  glassShapeCount: u32,
}

/** vec4f throughout for the same reason as `Camera`; layout is unchanged. */
struct Quad {
  origin: vec4f,   // xyz = corner, w = area
  u: vec4f,        // xyz = first edge,  w = 1/|u|^2
  v: vec4f,        // xyz = second edge, w = 1/|v|^2
  normal: vec4f,   // xyz = unit normal
  albedo: vec4f,   // xyz = diffuse albedo
  emission: vec4f, // xyz = emitted radiance
}

struct GlassShape {
  centerKind: vec4f, // xyz = centre, w = 0 sphere / 1 box
  extentRadius: vec4f, // xyz = box half extents, w = sphere radius
  tintIor: vec4f, // xyz = transmission tint, w = index of refraction
}

struct Light {
  quadIndex: u32,
  cdf: f32,
  selectPdf: f32,
  _pad0: f32,
}

/**
 * Bound around a run of occluder quads. Counts ride in the w lanes for the
 * same portability reason as `Camera`; they are small integers, so f32 is exact.
 */
struct Cluster {
  lo: vec4f, // xyz = min corner, w = index of the first quad
  hi: vec4f, // xyz = max corner, w = number of quads
}

// Direct-lighting reservoir. The chosen sample is a point on an emissive quad;
// its normal and radiance are re-read from `quads[lightQuad]` on demand rather
// than stored, which keeps the per-pixel footprint at 32 bytes.
struct DiReservoir {
  lightPos: vec4f, // xyz = point on the emissive quad
  lightQuad: u32,
  wSum: f32,
  m: f32,
  targetPdf: f32,
}

// Indirect-lighting reservoir. The sample is a surface point with the outgoing
// radiance it carries towards the visible point that generated it. Scalars ride
// in the w lanes for the same portability reason as `Camera`; still 48 bytes.
struct GiReservoir {
  samplePos: vec4f,    // xyz = sample point,  w = m
  sampleNormal: vec4f, // xyz = sample normal, w = wSum
  radiance: vec4f,     // xyz = outgoing radiance, w = targetPdf
}

fn giM(r: GiReservoir) -> f32 {
  return r.samplePos.w;
}

fn giWSum(r: GiReservoir) -> f32 {
  return r.sampleNormal.w;
}

fn giTarget(r: GiReservoir) -> f32 {
  return r.radiance.w;
}

// Writes go through these too: with the lane mapping hardcoded at each write
// site, reshuffling the lanes would update the readers and silently corrupt
// the writers.
fn giSetM(r: ptr<function, GiReservoir>, value: f32) {
  (*r).samplePos.w = value;
}

fn giAddM(r: ptr<function, GiReservoir>, inc: f32) {
  (*r).samplePos.w += inc;
}

fn giSetWSum(r: ptr<function, GiReservoir>, value: f32) {
  (*r).sampleNormal.w = value;
}

fn giAddWSum(r: ptr<function, GiReservoir>, inc: f32) {
  (*r).sampleNormal.w += inc;
}

/** Replaces the stored sample, preserving the running m and wSum. */
fn giSetSample(
  r: ptr<function, GiReservoir>,
  samplePos: vec3f,
  sampleNormal: vec3f,
  radiance: vec3f,
  targetPdf: f32,
) {
  (*r).samplePos = vec4f(samplePos, giM(*r));
  (*r).sampleNormal = vec4f(sampleNormal, giWSum(*r));
  (*r).radiance = vec4f(radiance, targetPdf);
}

/** A single-sample reservoir with m and wSum still zero. */
fn giReservoirSample(
  samplePos: vec3f,
  sampleNormal: vec3f,
  radiance: vec3f,
) -> GiReservoir {
  return GiReservoir(
    vec4f(samplePos, 0.0),
    vec4f(sampleNormal, 0.0),
    vec4f(radiance, 0.0),
  );
}

const FLAG_DI_ENABLED: u32 = 1u;
const FLAG_DI_TEMPORAL: u32 = 2u;
const FLAG_DI_SPATIAL: u32 = 4u;
const FLAG_GI_ENABLED: u32 = 8u;
const FLAG_GI_TEMPORAL: u32 = 16u;
const FLAG_GI_SPATIAL: u32 = 32u;
const FLAG_DENOISE: u32 = 64u;

// ---------------------------------------------------------------- RNG

var<private> gRngState: u32;

fn pcgNext() -> u32 {
  gRngState = gRngState * 747796405u + 2891336453u;
  let word = ((gRngState >> ((gRngState >> 28u) + 4u)) ^ gRngState) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rngInit(pixel: vec2u, frame: u32, salt: u32) {
  gRngState = pixel.x * 1973u + pixel.y * 9277u + frame * 26699u + salt * 6151u;
  gRngState = pcgNext();
  gRngState = pcgNext();
}

fn rand() -> f32 {
  return f32(pcgNext()) * 2.3283064365386963e-10;
}

fn rand2() -> vec2f {
  return vec2f(rand(), rand());
}

// ---------------------------------------------------------------- math

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn maxComponent(c: vec3f) -> f32 {
  return max(c.x, max(c.y, c.z));
}

fn safeDiv(a: f32, b: f32) -> f32 {
  return select(0.0, a / b, b > 0.0);
}

// Duff et al., "Building an Orthonormal Basis, Revisited".
fn onbFromNormal(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  return mat3x3f(
    vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x),
    vec3f(b, s + n.y * n.y * a, -n.y),
    n,
  );
}

fn cosineSampleHemisphere(n: vec3f, u1: f32, u2: f32) -> vec3f {
  let r = sqrt(u1);
  let phi = 2.0 * PI * u2;
  let local = vec3f(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1)));
  return normalize(onbFromNormal(n) * local);
}

/**
 * View ray through `ndc`, unnormalised so its forward component is exactly 1.
 * That is what makes the G-buffer's stored depth a plain view-space distance:
 * `pos = cam.pos + viewRay * depth`, with no renormalisation on either side.
 */
fn viewRay(cam: Camera, ndc: vec2f) -> vec3f {
  return cam.forward.xyz
    + cam.right.xyz * (ndc.x * camTanHalfFov(cam) * camAspect(cam))
    + cam.up.xyz * (ndc.y * camTanHalfFov(cam));
}

/** `ndc` is y-up in [-1, 1]. Mirrored by `primaryRayDirection` in camera.ts. */
fn primaryRayDir(cam: Camera, ndc: vec2f) -> vec3f {
  return normalize(viewRay(cam, ndc));
}

/** Centre of `pixel` in y-up normalised device coordinates. */
fn pixelNdc(pixel: vec2u) -> vec2f {
  let uv = (vec2f(pixel) + 0.5) / vec2f(uni.resolution);
  return vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
}

/**
 * The G-buffer stores view-space depth rather than a world position: the `.w`
 * lane of an rgba32float only ever carried a hit flag, so three quarters of the
 * widest and most-read target were reconstructible all along. Depth is
 * `dot(pos - eye, forward)`, which the unit-forward `viewRay` inverts directly.
 */
fn surfaceDepth(cam: Camera, pos: vec3f) -> f32 {
  return dot(pos - cam.pos.xyz, cam.forward.xyz);
}

fn surfacePosition(cam: Camera, pixel: vec2u, depth: f32) -> vec3f {
  return cam.pos.xyz + viewRay(cam, pixelNdc(pixel)) * depth;
}

/** Zero means the primary ray escaped; every real hit is in front of the eye. */
fn surfaceHit(depth: f32) -> bool {
  return depth > 0.0;
}

/** Returns top-left-origin screen UV in xy; z is 1 when the point is on screen. */
fn projectToUv(cam: Camera, p: vec3f) -> vec3f {
  let d = p - cam.pos.xyz;
  let z = dot(d, cam.forward.xyz);
  if (z <= 1e-4) {
    return vec3f(0.0, 0.0, 0.0);
  }
  let x = dot(d, cam.right.xyz) / (z * camTanHalfFov(cam) * camAspect(cam));
  let y = dot(d, cam.up.xyz) / (z * camTanHalfFov(cam));
  let onScreen = select(0.0, 1.0, abs(x) <= 1.0 && abs(y) <= 1.0);
  return vec3f(x * 0.5 + 0.5, 0.5 - y * 0.5, onScreen);
}

/**
 * Pixel coordinates as one u32, for the spatial passes' dynamically-indexed
 * neighbour lists. 16 bits per axis covers any resolution the renderer can
 * allocate, and halves an array that lives in per-thread scratch.
 */
fn packPixel(pixel: vec2u) -> u32 {
  return (pixel.y << 16u) | (pixel.x & 0xffffu);
}

fn unpackPixel(packed: u32) -> vec2u {
  return vec2u(packed & 0xffffu, packed >> 16u);
}

// ---------------------------------------------------------------- reservoirs

fn diReservoirEmpty() -> DiReservoir {
  return DiReservoir(vec4f(0.0), 0u, 0.0, 0.0, 0.0);
}

/** Weighted reservoir sampling: fold one candidate of weight `w` into `r`. */
fn diReservoirUpdate(
  r: ptr<function, DiReservoir>,
  lightPos: vec3f,
  lightQuad: u32,
  w: f32,
  targetPdf: f32,
  mInc: f32,
  u: f32,
) {
  (*r).m += mInc;
  if (w <= 0.0) {
    return;
  }
  (*r).wSum += w;
  if (u * (*r).wSum <= w) {
    (*r).lightPos = vec4f(lightPos, 0.0);
    (*r).lightQuad = lightQuad;
    (*r).targetPdf = targetPdf;
  }
}

/** Unbiased contribution weight of the surviving sample. */
fn diReservoirWeight(r: DiReservoir) -> f32 {
  return safeDiv(r.wSum, r.m * r.targetPdf);
}

/**
 * Bound the history length. `wSum` is scaled by the same factor because the
 * contribution weight is derived as `wSum / (M * targetPdf)`: capping `M`
 * alone inflates every reused weight, and the error compounds each frame until
 * the estimate diverges.
 */
fn diReservoirCapM(r: DiReservoir, cap: f32) -> DiReservoir {
  if (r.m <= cap || r.m <= 0.0) {
    return r;
  }
  var capped = r;
  capped.wSum = r.wSum * (cap / r.m);
  capped.m = cap;
  return capped;
}

fn giReservoirEmpty() -> GiReservoir {
  return GiReservoir(vec4f(0.0), vec4f(0.0, 1.0, 0.0, 0.0), vec4f(0.0));
}

fn giReservoirUpdate(
  r: ptr<function, GiReservoir>,
  samplePos: vec3f,
  sampleNormal: vec3f,
  radiance: vec3f,
  w: f32,
  targetPdf: f32,
  mInc: f32,
  u: f32,
) {
  giAddM(r, mInc);
  if (w <= 0.0) {
    return;
  }
  giAddWSum(r, w);
  if (u * giWSum(*r) <= w) {
    giSetSample(r, samplePos, sampleNormal, radiance, targetPdf);
  }
}

fn giReservoirWeight(r: GiReservoir) -> f32 {
  return safeDiv(giWSum(r), giM(r) * giTarget(r));
}

/** See `diReservoirCapM`. */
fn giReservoirCapM(r: GiReservoir, cap: f32) -> GiReservoir {
  if (giM(r) <= cap || giM(r) <= 0.0) {
    return r;
  }
  var capped = r;
  giSetWSum(&capped, giWSum(r) * (cap / giM(r)));
  giSetM(&capped, cap);
  return capped;
}

// ---------------------------------------------------------------- display

fn acesFilmic(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
