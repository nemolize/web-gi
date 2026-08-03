// Edge-aware a-trous wavelet filter (SVGF-style stopping functions, with the
// luminance sigma driven by history length instead of a variance estimate).
// The alpha channel carries history length through the iteration chain.

@group(1) @binding(0) var texColor: texture_2d<f32>;
@group(1) @binding(1) var texPosition: texture_2d<f32>;
@group(1) @binding(2) var texNormal: texture_2d<f32>;
@group(1) @binding(3) var outColor: texture_storage_2d<rgba32float, write>;
@group(1) @binding(4) var<uniform> atrous: AtrousStep;

struct AtrousStep {
  stride: i32,
  _pad0: i32,
  _pad1: i32,
  _pad2: i32,
}

const NORMAL_POWER: f32 = 64.0;
const SIGMA_PLANE: f32 = 0.02;
const SIGMA_LUMINANCE: f32 = 6.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }

  let center = textureLoad(texColor, pixel, 0);
  let position = textureLoad(texPosition, pixel, 0);
  if (position.w < 0.5 || (uni.flags & FLAG_DENOISE) == 0u) {
    textureStore(outColor, pixel, center);
    return;
  }

  let x = position.xyz;
  let n = textureLoad(texNormal, pixel, 0).xyz;
  let historyLength = max(center.w, 1.0);
  let centerLuminance = luminance(center.xyz);
  // Filter hard while history is short, then fade out as the estimate settles.
  let sigmaLuminance = SIGMA_LUMINANCE / sqrt(historyLength);

  var kernel = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);
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
      let tapPosition = textureLoad(texPosition, tap, 0);
      if (tapPosition.w < 0.5) {
        continue;
      }
      let tapNormal = textureLoad(texNormal, tap, 0).xyz;
      let tapColor = textureLoad(texColor, tap, 0).xyz;

      let normalWeight = pow(max(dot(n, tapNormal), 0.0), NORMAL_POWER);
      let planeWeight = exp(-abs(dot(n, tapPosition.xyz - x)) / SIGMA_PLANE);
      let luminanceWeight = exp(
        -abs(luminance(tapColor) - centerLuminance) / (sigmaLuminance + 1e-4),
      );
      let kernelWeight = kernel[dx + 2] * kernel[dy + 2];
      let weight = kernelWeight * normalWeight * planeWeight * luminanceWeight;

      sum += tapColor * weight;
      weightSum += weight;
    }
  }

  let filtered = select(center.xyz, sum / weightSum, weightSum > 1e-6);
  textureStore(outColor, pixel, vec4f(filtered, center.w));
}
