// Resolves both reservoirs into one albedo-demodulated illumination value.
// Demodulation keeps texture detail out of the denoiser's edge-stopping terms;
// the present pass multiplies the albedo back in.

@group(1) @binding(0) var texPosition: texture_2d<f32>;
@group(1) @binding(1) var texNormal: texture_2d<f32>;
@group(1) @binding(2) var<storage, read> diReservoirs: array<DiReservoir>;
@group(1) @binding(3) var<storage, read> giReservoirs: array<GiReservoir>;
@group(1) @binding(4) var outIllumination: texture_storage_2d<rgba16float, write>;

/** Firefly guard; generous enough that it never clips the lit floor. */
const MAX_ILLUMINATION: f32 = 200.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  let index = pixel.y * uni.resolution.x + pixel.x;

  let position = textureLoad(texPosition, pixel, 0);
  if (position.w < 0.5) {
    textureStore(outIllumination, pixel, vec4f(0.0));
    return;
  }
  let x = position.xyz;
  let n = textureLoad(texNormal, pixel, 0).xyz;

  var illumination = vec3f(0.0);

  let di = diReservoirs[index];
  let diWeight = diReservoirWeight(di);
  if (diWeight > 0.0) {
    let contribution = directContribution(x, n, vec3f(1.0), di.lightPos.xyz, di.lightQuad);
    // Visibility is excluded from the RIS target function, so it is applied
    // exactly once here, on the surviving sample.
    if (maxComponent(contribution) > 0.0 && mutuallyVisible(x, n, di.lightPos.xyz)) {
      illumination += contribution * diWeight;
    }
  }

  let gi = giReservoirs[index];
  let giWeight = giReservoirWeight(gi);
  if (giWeight > 0.0) {
    illumination += giContribution(x, n, vec3f(1.0), gi) * giWeight;
  }

  illumination = min(illumination, vec3f(MAX_ILLUMINATION));
  textureStore(outIllumination, pixel, vec4f(illumination, 1.0));
}
