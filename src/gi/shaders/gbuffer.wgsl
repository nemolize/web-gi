// Primary visibility. Writes the G-buffer that every later pass reads.

@group(1) @binding(0) var outPosition: texture_storage_2d<rgba32float, write>;
@group(1) @binding(1) var outNormal: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var outAlbedo: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(3) var outEmission: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  rngInit(pixel, uni.frame, 1u);

  // Sub-pixel jitter; reprojection keys off world position, so it costs no
  // temporal stability and buys free anti-aliasing once history accumulates.
  let jitter = rand2() - 0.5;
  let uv = (vec2f(pixel) + 0.5 + jitter) / vec2f(uni.resolution);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let hit = traceScenePrimary(uni.cam.pos, primaryRayDir(uni.cam, ndc));

  if (!hit.hit) {
    textureStore(outPosition, pixel, vec4f(0.0));
    textureStore(outNormal, pixel, vec4f(0.0, 1.0, 0.0, 0.0));
    textureStore(outAlbedo, pixel, vec4f(0.0));
    textureStore(outEmission, pixel, vec4f(0.0));
    return;
  }

  textureStore(outPosition, pixel, vec4f(hit.pos, 1.0));
  textureStore(outNormal, pixel, vec4f(hit.normal, 0.0));
  textureStore(outAlbedo, pixel, vec4f(hit.albedo, 1.0));
  textureStore(outEmission, pixel, vec4f(hit.emission, 1.0));
}
