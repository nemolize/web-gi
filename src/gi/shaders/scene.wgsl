// Scene bindings and the ray-tracing / light-sampling kernel shared by every
// compute pass. Group 0 is identical for all of them so a single explicit bind
// group layout can be reused.

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var<storage, read> quads: array<Quad>;
@group(0) @binding(2) var<storage, read> lights: array<Light>;

struct HitInfo {
  hit: bool,
  t: f32,
  pos: vec3f,
  normal: vec3f,
  albedo: vec3f,
  emission: vec3f,
  quadIndex: u32,
}

/**
 * Ray/parallelogram intersection. Quad edges are perpendicular by construction
 * (see `makeQuad`), so the barycentric solve is two independent projections.
 */
fn intersectQuad(q: Quad, ro: vec3f, rd: vec3f, tMax: f32) -> f32 {
  let denom = dot(q.normal, rd);
  if (abs(denom) < 1e-9) {
    return -1.0;
  }
  let t = dot(q.normal, q.origin - ro) / denom;
  if (t <= RAY_EPS || t >= tMax) {
    return -1.0;
  }
  let p = ro + rd * t - q.origin;
  let a = dot(p, q.u) / dot(q.u, q.u);
  if (a < 0.0 || a > 1.0) {
    return -1.0;
  }
  let b = dot(p, q.v) / dot(q.v, q.v);
  if (b < 0.0 || b > 1.0) {
    return -1.0;
  }
  return t;
}

fn traceScene(ro: vec3f, rd: vec3f) -> HitInfo {
  var best: HitInfo;
  best.hit = false;
  best.t = T_FAR;
  best.quadIndex = 0u;
  for (var i = 0u; i < uni.quadCount; i = i + 1u) {
    let q = quads[i];
    let t = intersectQuad(q, ro, rd, best.t);
    if (t > 0.0) {
      best.hit = true;
      best.t = t;
      best.quadIndex = i;
      best.normal = select(q.normal, -q.normal, dot(q.normal, rd) > 0.0);
      best.albedo = q.albedo;
      best.emission = q.emission;
    }
  }
  best.pos = ro + rd * best.t;
  return best;
}

/**
 * Primary-ray variant with back-face culling. The room is closed, so without
 * it the near wall would hide the interior; culling turns the eye-side wall
 * into a cutaway while secondary rays still bounce off it. Blocks are convex,
 * so culling their back faces changes nothing.
 */
fn traceScenePrimary(ro: vec3f, rd: vec3f) -> HitInfo {
  var best: HitInfo;
  best.hit = false;
  best.t = T_FAR;
  best.quadIndex = 0u;
  for (var i = 0u; i < uni.quadCount; i = i + 1u) {
    let q = quads[i];
    if (dot(q.normal, rd) > 0.0) {
      continue;
    }
    let t = intersectQuad(q, ro, rd, best.t);
    if (t > 0.0) {
      best.hit = true;
      best.t = t;
      best.quadIndex = i;
      best.normal = q.normal;
      best.albedo = q.albedo;
      best.emission = q.emission;
    }
  }
  best.pos = ro + rd * best.t;
  return best;
}

fn traceOccluded(ro: vec3f, rd: vec3f, tMax: f32) -> bool {
  for (var i = 0u; i < uni.quadCount; i = i + 1u) {
    if (intersectQuad(quads[i], ro, rd, tMax) > 0.0) {
      return true;
    }
  }
  return false;
}

/** True when nothing blocks the segment between two surface points. */
fn mutuallyVisible(origin: vec3f, originNormal: vec3f, destination: vec3f) -> bool {
  let d = destination - origin;
  let dist = length(d);
  if (dist < 1e-5) {
    return true;
  }
  let dir = d / dist;
  return !traceOccluded(origin + originNormal * SURFACE_EPS, dir, dist - 2.0 * SURFACE_EPS);
}

// ---------------------------------------------------------------- lights

struct LightSample {
  pos: vec3f,
  normal: vec3f,
  emission: vec3f,
  pdfArea: f32,
  quadIndex: u32,
}

fn pickLight(u: f32) -> u32 {
  var index = uni.lightCount - 1u;
  for (var i = 0u; i < uni.lightCount; i = i + 1u) {
    if (u < lights[i].cdf) {
      index = i;
      break;
    }
  }
  return index;
}

fn sampleLight(u0: f32, u1: f32, u2: f32) -> LightSample {
  var s: LightSample;
  let light = lights[pickLight(u0)];
  let q = quads[light.quadIndex];
  s.pos = q.origin + q.u * u1 + q.v * u2;
  s.normal = q.normal;
  s.emission = q.emission;
  s.quadIndex = light.quadIndex;
  s.pdfArea = safeDiv(light.selectPdf, q.area);
  return s;
}

/**
 * Unshadowed reflected radiance from a point on an emissive quad. Passing
 * `albedo = vec3f(1)` yields the albedo-demodulated form the shading pass
 * stores for the denoiser.
 */
fn directContribution(
  x: vec3f,
  n: vec3f,
  albedo: vec3f,
  lightPos: vec3f,
  lightQuad: u32,
) -> vec3f {
  let q = quads[lightQuad];
  let d = lightPos - x;
  let dist2 = max(dot(d, d), 1e-9);
  let wi = d * inverseSqrt(dist2);
  let cosX = dot(n, wi);
  let cosL = dot(q.normal, -wi);
  if (cosX <= 0.0 || cosL <= 0.0) {
    return vec3f(0.0);
  }
  return albedo * INV_PI * q.emission * (cosX * cosL / dist2);
}

/** RIS target function for direct lighting: visibility is deferred to shading. */
fn diTargetPdf(x: vec3f, n: vec3f, albedo: vec3f, lightPos: vec3f, lightQuad: u32) -> f32 {
  return luminance(directContribution(x, n, albedo, lightPos, lightQuad));
}

/** Reflected radiance towards the visible point for a stored GI sample. */
fn giContribution(x: vec3f, n: vec3f, albedo: vec3f, r: GiReservoir) -> vec3f {
  let d = r.samplePos - x;
  let dist2 = max(dot(d, d), 1e-9);
  let wi = d * inverseSqrt(dist2);
  let cosX = dot(n, wi);
  let cosY = dot(r.sampleNormal, -wi);
  if (cosX <= 0.0 || cosY <= 0.0) {
    return vec3f(0.0);
  }
  return albedo * INV_PI * r.radiance * cosX;
}

fn giTargetPdf(x: vec3f, n: vec3f, albedo: vec3f, r: GiReservoir) -> f32 {
  return luminance(giContribution(x, n, albedo, r));
}

/**
 * Reconnection Jacobian for moving a stored sample point from the visible
 * point `fromX` to `toX`: the solid-angle measure at the shading point changes
 * while the sample stays put.
 */
fn reconnectionJacobian(fromX: vec3f, toX: vec3f, samplePos: vec3f, sampleNormal: vec3f) -> f32 {
  let dFrom = fromX - samplePos;
  let dTo = toX - samplePos;
  let d2From = max(dot(dFrom, dFrom), 1e-9);
  let d2To = max(dot(dTo, dTo), 1e-9);
  let cosFrom = abs(dot(sampleNormal, dFrom * inverseSqrt(d2From)));
  let cosTo = abs(dot(sampleNormal, dTo * inverseSqrt(d2To)));
  if (cosFrom <= 1e-6) {
    return 0.0;
  }
  return clamp((cosTo * d2From) / (cosFrom * d2To), 0.01, 100.0);
}

// ---------------------------------------------------------------- path tracing

/** One next-event-estimation sample of direct lighting at a surface point. */
fn nextEventEstimation(pos: vec3f, n: vec3f, albedo: vec3f) -> vec3f {
  if (uni.lightCount == 0u) {
    return vec3f(0.0);
  }
  let ls = sampleLight(rand(), rand(), rand());
  if (ls.pdfArea <= 0.0) {
    return vec3f(0.0);
  }
  let d = ls.pos - pos;
  let dist2 = max(dot(d, d), 1e-9);
  let dist = sqrt(dist2);
  let wi = d / dist;
  let cosX = dot(n, wi);
  let cosL = dot(ls.normal, -wi);
  if (cosX <= 0.0 || cosL <= 0.0) {
    return vec3f(0.0);
  }
  if (traceOccluded(pos + n * SURFACE_EPS, wi, dist - 2.0 * SURFACE_EPS)) {
    return vec3f(0.0);
  }
  return albedo * INV_PI * ls.emission * (cosX * cosL / dist2) / ls.pdfArea;
}

/**
 * Radiance leaving a Lambertian surface point, excluding its own emission.
 * Lights are reached exclusively through NEE, so emissive hits along the walk
 * contribute nothing and no MIS weighting is needed.
 */
fn pathRadiance(startPos: vec3f, startNormal: vec3f, startAlbedo: vec3f, maxBounces: u32) -> vec3f {
  var radiance = vec3f(0.0);
  var throughput = vec3f(1.0);
  var pos = startPos;
  var normal = startNormal;
  var albedo = startAlbedo;

  for (var bounce = 0u; bounce < maxBounces; bounce = bounce + 1u) {
    radiance += throughput * nextEventEstimation(pos, normal, albedo);

    // Cosine-weighted sampling makes the BRDF/pdf ratio exactly the albedo.
    throughput *= albedo;
    if (bounce >= 1u) {
      let survival = clamp(maxComponent(throughput), 0.05, 1.0);
      if (rand() > survival) {
        break;
      }
      throughput /= survival;
    }
    let dir = cosineSampleHemisphere(normal, rand(), rand());
    let hit = traceScene(pos + normal * SURFACE_EPS, dir);
    if (!hit.hit) {
      break;
    }
    pos = hit.pos;
    normal = hit.normal;
    albedo = hit.albedo;
  }
  return radiance;
}
