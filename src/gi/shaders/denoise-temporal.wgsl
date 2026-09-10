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
@group(1) @binding(7) var texPreviousFiltered: texture_2d<f32>;

const PLANE_TOLERANCE: f32 = 0.02;
const NORMAL_TOLERANCE: f32 = 0.9;
/** History length below which a sample is still checked against its neighbours. */
const FIREFLY_HISTORY: f32 = 8.0;
const FIREFLY_SIGMA: f32 = 3.0;
/** Stands in for "no ceiling", above any luminance the shading pass can emit. */
const NO_CEILING: f32 = 1e20;

fn resizedHistory(uv: vec2f, x: vec3f, n: vec3f) -> vec4f {
  let texel = uv * vec2f(uni.previousResolution) - vec2f(0.5);
  let origin = vec2i(floor(texel));
  let fraction = fract(texel);
  var sum = vec4f(0.0);
  var weightSum = 0.0;
  for (var dy = 0; dy < 2; dy++) {
    for (var dx = 0; dx < 2; dx++) {
      let coord = origin + vec2i(dx, dy);
      if (any(coord < vec2i(0)) || any(coord >= vec2i(uni.previousResolution))) {
        continue;
      }
      let depth = textureLoad(texPrevDepth, coord, 0).x;
      let normal = textureLoad(texPrevNormal, coord, 0).xyz;
      let ndc = (vec2f(coord) + vec2f(0.5)) / vec2f(uni.previousResolution)
        * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
      let position = uni.prevCam.pos.xyz + viewRay(uni.prevCam, ndc) * depth;
      if (!surfaceHit(depth) || dot(normal, n) <= NORMAL_TOLERANCE
        || abs(dot(position - x, n)) >= PLANE_TOLERANCE) {
        continue;
      }
      let weight = select(1.0 - fraction.x, fraction.x, dx == 1)
        * select(1.0 - fraction.y, fraction.y, dy == 1);
      sum += textureLoad(texPreviousFiltered, coord, 0) * weight;
      weightSum += weight;
    }
  }
  if (weightSum <= 1e-6) {
    return vec4f(0.0);
  }
  let history = sum / weightSum;
  // Interpolated samples are correlated; cap confidence so new detail can converge.
  return vec4f(history.xyz, min(history.w, 16.0));
}

// Excluding the centre prevents an outlier from raising its own ceiling;
// a zero ceiling is ignored so dark neighbours cannot erase a valid estimate.
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

  if (uni.historyFrames > 0u) {
    let uv = projectToUv(uni.prevCam, x);
    if (uv.z > 0.5) {
      if (any(uni.previousResolution != uni.resolution)) {
        let stored = resizedHistory(uv.xy, x, n);
        history = stored.xyz;
        historyLength = stored.w;
      } else {
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
