// Temporal accumulation of the demodulated illumination.
//
// Every surface in the scene is Lambertian, so irradiance does not depend on
// the eye. History therefore stays valid while the camera moves and only needs
// to be dropped on disocclusion, which is why camera motion does not reset the
// accumulator.

@group(1) @binding(0) var texIllumination: texture_2d<f32>;
@group(1) @binding(1) var texPosition: texture_2d<f32>;
@group(1) @binding(2) var texNormal: texture_2d<f32>;
@group(1) @binding(3) var texPrevPosition: texture_2d<f32>;
@group(1) @binding(4) var texPrevNormal: texture_2d<f32>;
@group(1) @binding(5) var texHistory: texture_2d<f32>;
@group(1) @binding(6) var outHistory: texture_storage_2d<rgba32float, write>;

const PLANE_TOLERANCE: f32 = 0.02;
const NORMAL_TOLERANCE: f32 = 0.9;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }

  let position = textureLoad(texPosition, pixel, 0);
  if (position.w < 0.5) {
    textureStore(outHistory, pixel, vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let x = position.xyz;
  let n = textureLoad(texNormal, pixel, 0).xyz;
  let current = textureLoad(texIllumination, pixel, 0).xyz;

  var history = vec3f(0.0);
  var historyLength = 0.0;

  if (uni.accumFrames > 0u) {
    let uv = projectToUv(uni.prevCam, x);
    if (uv.z > 0.5) {
      let prevPixel = min(
        vec2u(uv.xy * vec2f(uni.resolution)),
        uni.resolution - vec2u(1u, 1u),
      );
      let prevPosition = textureLoad(texPrevPosition, prevPixel, 0);
      let prevNormal = textureLoad(texPrevNormal, prevPixel, 0).xyz;
      let samePlane = abs(dot(prevPosition.xyz - x, n)) < PLANE_TOLERANCE;
      if (prevPosition.w > 0.5 && samePlane && dot(prevNormal, n) > NORMAL_TOLERANCE) {
        let stored = textureLoad(texHistory, prevPixel, 0);
        history = stored.xyz;
        historyLength = stored.w;
      }
    }
  }

  let frames = min(historyLength + 1.0, f32(max(uni.maxHistory, 1u)));
  let blended = mix(history, current, 1.0 / frames);
  textureStore(outHistory, pixel, vec4f(blended, frames));
}
