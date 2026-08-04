// Primary visibility. Writes the G-buffer that every later pass reads.

@group(1) @binding(0) var outDepth: texture_storage_2d<r32float, write>;
@group(1) @binding(1) var outNormal: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var outAlbedo: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(3) var outEmission: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  // Unjittered on purpose: sub-pixel jitter flips edge pixels between two
  // surfaces every frame, so temporal reuse rejects their history and every
  // crease keeps a one-sample speckle line. It bought no anti-aliasing either,
  // since the present pass remodulates albedo from the current frame.
  let hit = traceScenePrimary(
    uni.cam.pos.xyz,
    primaryRayDir(uni.cam, pixelNdc(pixel)),
  );

  if (!hit.hit) {
    textureStore(outDepth, pixel, vec4f(0.0));
    textureStore(outNormal, pixel, vec4f(0.0, 1.0, 0.0, 0.0));
    textureStore(outAlbedo, pixel, vec4f(0.0));
    textureStore(outEmission, pixel, vec4f(0.0));
    return;
  }

  textureStore(outDepth, pixel, vec4f(surfaceDepth(uni.cam, hit.pos), 0.0, 0.0, 0.0));
  textureStore(outNormal, pixel, vec4f(hit.normal, 0.0));
  textureStore(outAlbedo, pixel, vec4f(hit.albedo, 1.0));
  textureStore(outEmission, pixel, vec4f(hit.emission, 1.0));
}
