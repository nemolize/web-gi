// Brute-force progressive path tracer used as the ground-truth comparison for
// the ReSTIR pipeline. Same light transport, no resampling and no denoiser:
// one path per pixel per frame, averaged over time.

@group(1) @binding(0) var texPrevAccum: texture_2d<f32>;
@group(1) @binding(1) var outAccum: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  rngInit(pixel, uni.frame, 7u);

  let jitter = rand2() - 0.5;
  let uv = (vec2f(pixel) + 0.5 + jitter) / vec2f(uni.resolution);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let primaryDirection = primaryRayDir(uni.cam, ndc);
  let hit = traceScenePrimary(uni.cam.pos.xyz, primaryDirection);

  var radiance = vec3f(0.0);
  if (hit.hit) {
    // One extra bounce so the path depth matches ReSTIR's
    // "one reconnection vertex + maxBounces" configuration.
    radiance = hit.emission
      + pathRadiance(
        hit.pos,
        hit.normal,
        hit.albedo,
        hit.materialIndex,
        hit.frontFace,
        primaryDirection,
        uni.maxBounces + 1u,
      );
  }

  let previous = textureLoad(texPrevAccum, pixel, 0);
  let count = select(previous.w, 0.0, uni.accumFrames == 0u) + 1.0;
  let averaged = mix(previous.xyz, radiance, 1.0 / count);
  textureStore(outAccum, pixel, vec4f(averaged, count));
}
