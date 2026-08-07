// Scene bindings and the ray-tracing / light-sampling kernel shared by every
// compute pass. Group 0 is identical for all of them so a single explicit bind
// group layout can be reused.

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var<storage, read> quads: array<Quad>;
@group(0) @binding(2) var<storage, read> lights: array<Light>;
@group(0) @binding(3) var<storage, read> clusters: array<Cluster>;

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
 *
 * Takes the index rather than the quad so each field is read only once the
 * preceding test has passed: a miss never touches `albedo` or `emission`.
 */
fn intersectQuad(index: u32, ro: vec3f, rd: vec3f, tMax: f32) -> f32 {
  let normal = quads[index].normal.xyz;
  let denom = dot(normal, rd);
  if (abs(denom) < 1e-9) {
    return -1.0;
  }
  let origin = quads[index].origin.xyz;
  let t = dot(normal, origin - ro) / denom;
  if (t <= RAY_EPS || t >= tMax) {
    return -1.0;
  }
  // `u.w` / `v.w` carry 1/|u|^2 and 1/|v|^2 from `packQuads`: recomputing them
  // here costs two dots and two divides on every quad of every ray.
  let p = ro + rd * t - origin;
  let u = quads[index].u;
  let a = dot(p, u.xyz) * u.w;
  if (a < 0.0 || a > 1.0) {
    return -1.0;
  }
  let v = quads[index].v;
  let b = dot(p, v.xyz) * v.w;
  if (b < 0.0 || b > 1.0) {
    return -1.0;
  }
  return t;
}

/**
 * Reciprocal that stays finite: the slab test multiplies by it, and an infinity
 * meeting a zero-length extent would produce a NaN that swallows the comparison.
 * The substituted magnitude is far beyond any t the scene can produce.
 */
fn safeInverse(v: f32) -> f32 {
  if (abs(v) < 1e-30) {
    return select(1e30, -1e30, v < 0.0);
  }
  return 1.0 / v;
}

/** Whether the segment `[RAY_EPS, tMax]` along `rd` can meet the box at all. */
fn segmentHitsBounds(lo: vec3f, hi: vec3f, ro: vec3f, invRd: vec3f, tMax: f32) -> bool {
  let a = (lo - ro) * invRd;
  let b = (hi - ro) * invRd;
  let near = min(a, b);
  let far = max(a, b);
  let enter = max(max(near.x, near.y), max(near.z, RAY_EPS));
  let exit = min(min(far.x, far.y), min(far.z, tMax));
  return enter <= exit;
}

/**
 * Closest hit, cluster by cluster. The traversal loop touches only the four
 * intersection fields; shading data is fetched once for the winner. Reading the
 * whole `Quad` per step instead keeps albedo and emission live across the loop,
 * and every ray pays that bandwidth on every quad it misses.
 */
fn traceScene(ro: vec3f, rd: vec3f) -> HitInfo {
  var best: HitInfo;
  best.hit = false;
  best.t = T_FAR;
  best.quadIndex = 0u;
  let invRd = vec3f(safeInverse(rd.x), safeInverse(rd.y), safeInverse(rd.z));
  // Walked back to front: the walls are the last cluster and a closest-hit ray
  // almost always reaches one, so taking them first gives `best.t` a real bound
  // immediately, and the block clusters ahead of them are then rejected by the
  // slab test instead of being intersected quad by quad.
  for (var c = uni.clusterCount; c > 0u; c = c - 1u) {
    let cluster = clusters[c - 1u];
    // `best.t` tightens as the walk proceeds, so a cluster already behind the
    // closest hit is rejected here too, not just one the ray line misses.
    if (!segmentHitsBounds(cluster.lo.xyz, cluster.hi.xyz, ro, invRd, best.t)) {
      continue;
    }
    let start = u32(cluster.lo.w);
    let end = start + u32(cluster.hi.w);
    for (var i = start; i < end; i = i + 1u) {
      let t = intersectQuad(i, ro, rd, best.t);
      if (t > 0.0) {
        best.hit = true;
        best.t = t;
        best.quadIndex = i;
      }
    }
  }
  if (best.hit) {
    let q = quads[best.quadIndex];
    best.normal = select(q.normal.xyz, -q.normal.xyz, dot(q.normal.xyz, rd) > 0.0);
    best.albedo = q.albedo.xyz;
    best.emission = q.emission.xyz;
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
  let invRd = vec3f(safeInverse(rd.x), safeInverse(rd.y), safeInverse(rd.z));
  // Back to front, for the same reason as `traceScene`.
  for (var c = uni.clusterCount; c > 0u; c = c - 1u) {
    let cluster = clusters[c - 1u];
    if (!segmentHitsBounds(cluster.lo.xyz, cluster.hi.xyz, ro, invRd, best.t)) {
      continue;
    }
    let start = u32(cluster.lo.w);
    let end = start + u32(cluster.hi.w);
    for (var i = start; i < end; i = i + 1u) {
      if (dot(quads[i].normal.xyz, rd) > 0.0) {
        continue;
      }
      let t = intersectQuad(i, ro, rd, best.t);
      if (t > 0.0) {
        best.hit = true;
        best.t = t;
        best.quadIndex = i;
      }
    }
  }
  if (best.hit) {
    let q = quads[best.quadIndex];
    best.normal = q.normal.xyz;
    best.albedo = q.albedo.xyz;
    best.emission = q.emission.xyz;
  }
  best.pos = ro + rd * best.t;
  return best;
}

/**
 * Segment occlusion between two points on the scene's interior surfaces. The
 * room is convex, so a segment with both ends inside it never reaches a wall —
 * and the walls are the last cluster, so stopping at `occluderClusterCount`
 * drops them. Closest-hit traversal walks every cluster: bounces do land on
 * walls.
 */
fn traceOccluded(ro: vec3f, rd: vec3f, tMax: f32) -> bool {
  let invRd = vec3f(safeInverse(rd.x), safeInverse(rd.y), safeInverse(rd.z));
  for (var c = 0u; c < uni.occluderClusterCount; c = c + 1u) {
    let cluster = clusters[c];
    if (!segmentHitsBounds(cluster.lo.xyz, cluster.hi.xyz, ro, invRd, tMax)) {
      continue;
    }
    let start = u32(cluster.lo.w);
    let end = start + u32(cluster.hi.w);
    for (var i = start; i < end; i = i + 1u) {
      if (intersectQuad(i, ro, rd, tMax) > 0.0) {
        return true;
      }
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

/**
 * First light whose inclusive CDF exceeds `u`, by binary search — the CDF is
 * non-decreasing, so this picks exactly what a scan from the front would. The
 * grid variant has thirty emitters and every next-event estimate calls this,
 * which made the scan's average depth the cost that mattered.
 */
fn pickLight(u: f32) -> u32 {
  var lo = 0u;
  var hi = uni.lightCount - 1u;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (u < lights[mid].cdf) {
      hi = mid;
    } else {
      lo = mid + 1u;
    }
  }
  return lo;
}

fn sampleLight(u0: f32, u1: f32, u2: f32) -> LightSample {
  var s: LightSample;
  let light = lights[pickLight(u0)];
  let q = quads[light.quadIndex];
  s.pos = q.origin.xyz + q.u.xyz * u1 + q.v.xyz * u2;
  s.normal = q.normal.xyz;
  s.emission = q.emission.xyz;
  s.quadIndex = light.quadIndex;
  s.pdfArea = safeDiv(light.selectPdf, q.origin.w);
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
  let cosL = dot(q.normal.xyz, -wi);
  if (cosX <= 0.0 || cosL <= 0.0) {
    return vec3f(0.0);
  }
  return albedo * INV_PI * q.emission.xyz * (cosX * cosL / dist2);
}

/** RIS target function for direct lighting: visibility is deferred to shading. */
fn diTargetPdf(x: vec3f, n: vec3f, albedo: vec3f, lightPos: vec3f, lightQuad: u32) -> f32 {
  return luminance(directContribution(x, n, albedo, lightPos, lightQuad));
}

/**
 * Whether `diTargetPdf` would be positive, without evaluating it. The 1/Z loops
 * only ask which contributors could have produced the surviving sample, and
 * everything the full form adds on top of the two cosines — the inverse square
 * root, the distance, `INV_PI` — is a strictly positive factor that cannot
 * change the answer. The unnormalised `d` therefore settles both signs.
 */
fn diSupported(x: vec3f, n: vec3f, albedo: vec3f, lightPos: vec3f, lightQuad: u32) -> bool {
  let q = quads[lightQuad];
  let d = lightPos - x;
  return dot(n, d) > 0.0
    && dot(q.normal.xyz, -d) > 0.0
    && luminance(albedo * q.emission.xyz) > 0.0;
}

/** Reflected radiance towards the visible point for a stored GI sample. */
fn giContribution(x: vec3f, n: vec3f, albedo: vec3f, r: GiReservoir) -> vec3f {
  let d = r.samplePos.xyz - x;
  let dist2 = max(dot(d, d), 1e-9);
  let wi = d * inverseSqrt(dist2);
  let cosX = dot(n, wi);
  let cosY = dot(r.sampleNormal.xyz, -wi);
  if (cosX <= 0.0 || cosY <= 0.0) {
    return vec3f(0.0);
  }
  return albedo * INV_PI * r.radiance.xyz * cosX;
}

fn giTargetPdf(x: vec3f, n: vec3f, albedo: vec3f, r: GiReservoir) -> f32 {
  return luminance(giContribution(x, n, albedo, r));
}

/** See `diSupported`; the same reduction, for a stored GI sample. */
fn giSupported(x: vec3f, n: vec3f, albedo: vec3f, r: GiReservoir) -> bool {
  let d = r.samplePos.xyz - x;
  return dot(n, d) > 0.0
    && dot(r.sampleNormal.xyz, -d) > 0.0
    && luminance(albedo * r.radiance.xyz) > 0.0;
}

/** Widest measure change a reused sample may carry before it is rejected. */
const MAX_RECONNECTION_JACOBIAN: f32 = 10.0;

/**
 * Reconnection Jacobian for moving a stored sample point from the visible
 * point `fromX` to `toX`: the solid-angle measure at the shading point changes
 * while the sample stays put. Returns 0 for a shift too distorted to reuse —
 * the ratio diverges where `toX` nearly touches the sample, so clamping instead
 * of rejecting would admit that sample at the clamp factor and blow out every
 * concave contact region.
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
  let jacobian = (cosTo * d2From) / (cosFrom * d2To);
  if (jacobian < 1.0 / MAX_RECONNECTION_JACOBIAN || jacobian > MAX_RECONNECTION_JACOBIAN) {
    return 0.0;
  }
  return jacobian;
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

    // The last vertex has already contributed; extending the walk from it would
    // trace a ray whose hit no iteration reads.
    if (bounce + 1u >= maxBounces) {
      break;
    }

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
