// Temporal accumulation of the demodulated illumination.
//
// Diffuse irradiance does not depend on the eye, so its history survives camera
// motion and is rejected only on disocclusion. Glass scenes reset this history
// from the CPU because their reflected and refracted radiance is view-dependent.

@group(1) @binding(0) var texIllumination: texture_2d<f32>;
@group(1) @binding(1) var texDepth: texture_2d<f32>;
@group(1) @binding(2) var texNormal: texture_2d<f32>;
@group(1) @binding(3) var texPrevDepth: texture_2d<f32>;
@group(1) @binding(4) var texPrevNormal: texture_2d<f32>;
@group(1) @binding(5) var texHistory: texture_2d<f32>;
@group(1) @binding(6) var outHistory: texture_storage_2d<rgba32float, write>;

const PLANE_TOLERANCE: f32 = 0.02;
const NORMAL_TOLERANCE: f32 = 0.9;
/** History length below which a sample is still checked against its neighbours. */
const FIREFLY_HISTORY: f32 = 8.0;
const FIREFLY_SIGMA: f32 = 3.0;
/** Stands in for "no ceiling", above any luminance the shading pass can emit. */
const NO_CEILING: f32 = 1e20;

/**
 * Luminance ceiling drawn from the neighbours that share this pixel's surface,
 * or `NO_CEILING` when too few of them do, or when they agree on darkness and
 * would otherwise zero a legitimate estimate. Excludes the centre so an outlier
 * cannot raise its own ceiling.
 */
fn neighbourhoodCeiling(pixel: vec2u, x: vec3f, n: vec3f) -> f32 {
  var sum = 0.0;
  var sumSquares = 0.0;
  var count = 0.0;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      if (dx == 0 && dy == 0) {
        continue;
      }
      let coord = vec2i(pixel) + vec2i(dx, dy);
      if (coord.x < 0 || coord.y < 0
        || coord.x >= i32(uni.resolution.x) || coord.y >= i32(uni.resolution.y)) {
        continue;
      }
      let tap = vec2u(coord);
      let tapDepth = textureLoad(texDepth, tap, 0).x;
      let tapNormal = textureLoad(texNormal, tap, 0).xyz;
      let tapPosition = surfacePosition(uni.cam, tap, tapDepth);
      if (!surfaceHit(tapDepth)
        || dot(tapNormal, n) < NORMAL_TOLERANCE
        || abs(dot(tapPosition - x, n)) > PLANE_TOLERANCE) {
        continue;
      }
      let tapLuminance = luminance(textureLoad(texIllumination, tap, 0).xyz);
      sum += tapLuminance;
      sumSquares += tapLuminance * tapLuminance;
      count += 1.0;
    }
  }
  if (count < 2.0) {
    return NO_CEILING;
  }
  let mean = sum / count;
  let variance = max(sumSquares / count - mean * mean, 0.0);
  let ceiling = mean + FIREFLY_SIGMA * sqrt(variance);
  return select(ceiling, NO_CEILING, ceiling <= 0.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }

  let depth = textureLoad(texDepth, pixel, 0).x;
  if (!surfaceHit(depth)) {
    textureStore(outHistory, pixel, vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let x = surfacePosition(uni.cam, pixel, depth);
  let n = textureLoad(texNormal, pixel, 0).xyz;
  let current = textureLoad(texIllumination, pixel, 0).xyz;

  var history = vec3f(0.0);
  var historyLength = 0.0;

  if (uni.accumFrames > 0u) {
    let uv = projectToUv(uni.prevCam, x);
    if (uv.z > 0.5) {
      let prevPixel = min(
        vec2u(uv.xy * vec2f(uni.resolution)),
        uni.resolution - vec2u(1u, 1u),
      );
      let prevDepth = textureLoad(texPrevDepth, prevPixel, 0).x;
      let prevNormal = textureLoad(texPrevNormal, prevPixel, 0).xyz;
      let prevPosition = surfacePosition(uni.prevCam, prevPixel, prevDepth);
      let samePlane = abs(dot(prevPosition - x, n)) < PLANE_TOLERANCE;
      if (surfaceHit(prevDepth) && samePlane && dot(prevNormal, n) > NORMAL_TOLERANCE) {
        let stored = textureLoad(texHistory, prevPixel, 0);
        history = stored.xyz;
        historyLength = stored.w;
      }
    }
  }

  // A disoccluded pixel carries a one-sample estimate, and on a silhouette the
  // a-trous pass cannot rescue it: its own edge-stopping weights reject the taps
  // across the edge, so an outlier survives as a firefly that tracks the
  // geometry. Bound it by the surface's own neighbours until history is deep
  // enough to have averaged it away on its own.
  // The threshold has to follow `maxHistory` too: `historyLength` saturates
  // there, so a window shorter than FIREFLY_HISTORY would leave the clamp on
  // for good and bias the steady state dark.
  var sample = current;
  if (historyLength < min(FIREFLY_HISTORY, f32(max(uni.maxHistory, 1u)))) {
    let ceiling = neighbourhoodCeiling(pixel, x, n);
    let sampleLuminance = luminance(sample);
    if (sampleLuminance > ceiling) {
      sample *= ceiling / sampleLuminance;
    }
  }

  let frames = min(historyLength + 1.0, f32(max(uni.maxHistory, 1u)));
  let blended = mix(history, sample, 1.0 / frames);
  textureStore(outHistory, pixel, vec4f(blended, frames));
}
