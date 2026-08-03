// Writes the linear radiance the present pass would tone map, so it can be
// read back and compared against the reference path tracer. Tone mapping and
// the sRGB encode are deliberately excluded: ACES compresses exactly the
// highlights an error metric needs to see, and 8-bit output quantises the rest.

@group(1) @binding(0) var texColor: texture_2d<f32>;
@group(1) @binding(1) var texAlbedo: texture_2d<f32>;
@group(1) @binding(2) var texEmission: texture_2d<f32>;
@group(1) @binding(3) var outLinear: texture_storage_2d<rgba32float, write>;

/** Mirrors `fsRestir` in `present.wgsl`, minus `display`. */
@compute @workgroup_size(8, 8)
fn restir(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  let illumination = textureLoad(texColor, pixel, 0).xyz;
  let albedo = textureLoad(texAlbedo, pixel, 0).xyz;
  let emission = textureLoad(texEmission, pixel, 0).xyz;
  textureStore(outLinear, pixel, vec4f(illumination * albedo + emission, 1.0));
}

/** Mirrors `fsReference`; the albedo and emission bindings go unread. */
@compute @workgroup_size(8, 8)
fn reference(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  textureStore(outLinear, pixel, vec4f(textureLoad(texColor, pixel, 0).xyz, 1.0));
}
