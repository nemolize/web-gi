// One path sample, demodulated by the visible surface's albedo so it can feed
// the same temporal accumulator and edge-aware filter as the ReSTIR estimate.

@group(1) @binding(0) var texDepth: texture_2d<f32>;
@group(1) @binding(1) var texNormal: texture_2d<f32>;
@group(1) @binding(2) var outIllumination: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }

  let depth = textureLoad(texDepth, pixel, 0).x;
  if (!surfaceHit(depth)) {
    textureStore(outIllumination, pixel, vec4f(0.0));
    return;
  }

  rngInit(pixel, uni.frame, 7u);
  let position = surfacePosition(uni.cam, pixel, depth);
  let normal = textureLoad(texNormal, pixel, 0).xyz;
  let illumination = min(
    pathRadiance(
      position,
      normal,
      vec3f(1.0),
      uni.maxBounces + 1u,
    ),
    vec3f(MAX_ILLUMINATION),
  );
  textureStore(outIllumination, pixel, vec4f(illumination, 1.0));
}
