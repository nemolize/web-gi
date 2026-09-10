@group(1) @binding(0) var texColor: texture_2d<f32>;
@group(1) @binding(1) var texAlbedo: texture_2d<f32>;
@group(1) @binding(2) var texEmission: texture_2d<f32>;
@group(1) @binding(3) var outSnapshot: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (any(pixel >= vec2u(uni.transition.xy))) {
    return;
  }
  let radiance = textureLoad(texColor, pixel, 0).xyz
    * textureLoad(texAlbedo, pixel, 0).xyz
    + textureLoad(texEmission, pixel, 0).xyz;
  textureStore(outSnapshot, pixel,
    vec4f(linearToSrgb(acesFilmic(radiance * uni.exposure)), 1.0));
}
