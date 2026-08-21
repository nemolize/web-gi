// Edge-aware a-trous wavelet filter shared by the tiled and texture-backed
// loaders. The alpha channel carries history length through the chain.

@group(1) @binding(0) var texColor: texture_2d<f32>;
@group(1) @binding(1) var texDepth: texture_2d<f32>;
@group(1) @binding(2) var texNormal: texture_2d<f32>;
@group(1) @binding(3) var outColor: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var<uniform> atrous: AtrousStep;

struct AtrousStep {
  stride: i32,
  _pad0: i32,
  _pad1: i32,
  _pad2: i32,
}

const SIGMA_PLANE: f32 = 0.02;
/**
 * Bounds how far along the surface a tap may sit. Without it the filter's reach
 * is `14 * worldPerPixel / cos(incidence)` — it grows as pixels get larger and
 * again as the surface tilts, so the same kernel averages a hand's width of a
 * wall head-on and a third of the room at a grazing angle (#80).
 *
 * Derived rather than swept: `0.08` is roughly what the kernel already spanned
 * head-on at the preset's own resolution, so it leaves that case alone.
 */
const SIGMA_TANGENT: f32 = 0.08;
const SIGMA_LUMINANCE: f32 = 6.0;
// Module scope avoids rebuilding a mutable, dynamically indexed private array
// for every invocation and keeps the filter weights immutable.
const KERNEL = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);

fn normalFalloff(x: f32) -> f32 {
  let x2 = x * x;
  let x4 = x2 * x2;
  let x8 = x4 * x4;
  let x16 = x8 * x8;
  let x32 = x16 * x16;
  return x32 * x32;
}

@compute @workgroup_size(ATROUS_WORKGROUP_SIZE, ATROUS_WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
  @builtin(workgroup_id) workgroup: vec3u,
) {
  let pixel = gid.xy;

  // Uniform across the workgroup, so the tiled loader can bypass its barrier.
  if ((uni.flags & FLAG_DENOISE) == 0u) {
    if (pixel.x < uni.resolution.x && pixel.y < uni.resolution.y) {
      textureStore(outColor, pixel, textureLoad(texColor, pixel, 0));
    }
    return;
  }

  prepareAtrousTile(localIndex, workgroup);
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }

  let center = textureLoad(texColor, pixel, 0);
  let centerTile = atrousCenterTile(lid);
  let depth = atrousDepth(pixel, vec2i(centerTile));
  if (!surfaceHit(depth)) {
    textureStore(outColor, pixel, center);
    return;
  }

  let x = surfacePosition(uni.cam, pixel, depth);
  let n = atrousNormal(pixel, vec2i(centerTile));
  let historyLength = max(center.w, 1.0);
  let centerLuminance = luminance(center.xyz);
  let sigmaLuminance = SIGMA_LUMINANCE / sqrt(historyLength);

  var sum = vec3f(0.0);
  var weightSum = 0.0;
  for (var dy = -2; dy <= 2; dy = dy + 1) {
    for (var dx = -2; dx <= 2; dx = dx + 1) {
      let coord = vec2i(pixel) + vec2i(dx, dy) * atrous.stride;
      if (coord.x < 0 || coord.y < 0
        || coord.x >= i32(uni.resolution.x) || coord.y >= i32(uni.resolution.y)) {
        continue;
      }
      let tap = vec2u(coord);
      let tileCoord = vec2i(centerTile) + vec2i(dx, dy) * atrous.stride;
      let tapDepth = atrousDepth(tap, tileCoord);
      if (!surfaceHit(tapDepth)) {
        continue;
      }
      let tapPosition = surfacePosition(uni.cam, tap, tapDepth);
      let tapNormal = atrousNormal(tap, tileCoord);
      let tapColor = atrousColor(tap, tileCoord);

      let normalWeight = normalFalloff(max(dot(n, tapNormal), 0.0));
      let offset = tapPosition - x;
      let alongNormal = dot(n, offset);
      let edge = abs(alongNormal) / SIGMA_PLANE
        + length(offset - alongNormal * n) / SIGMA_TANGENT
        + abs(luminance(tapColor) - centerLuminance) / (sigmaLuminance + 1e-4);
      let kernelWeight = KERNEL[dx + 2] * KERNEL[dy + 2];
      let weight = kernelWeight * normalWeight * exp(-edge);

      sum += tapColor * weight;
      weightSum += weight;
    }
  }

  let filtered = select(center.xyz, sum / weightSum, weightSum > 1e-6);
  textureStore(outColor, pixel, vec4f(filtered, center.w));
}
