// ReSTIR GI, stage 1: trace one indirect bounce to create a sample point,
// evaluate the radiance it carries, then reuse the reprojected history.

@group(1) @binding(0) var texPosition: texture_2d<f32>;
@group(1) @binding(1) var texNormal: texture_2d<f32>;
@group(1) @binding(2) var texAlbedo: texture_2d<f32>;
@group(1) @binding(3) var texPrevPosition: texture_2d<f32>;
@group(1) @binding(4) var texPrevNormal: texture_2d<f32>;
@group(1) @binding(5) var<storage, read> prevReservoirs: array<GiReservoir>;
@group(1) @binding(6) var<storage, read_write> outReservoirs: array<GiReservoir>;

const PLANE_TOLERANCE: f32 = 0.02;
const NORMAL_TOLERANCE: f32 = 0.9;
const TEMPORAL_M_CAP: f32 = 30.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  let index = pixel.y * uni.resolution.x + pixel.x;

  let position = textureLoad(texPosition, pixel, 0);
  let enabled = (uni.flags & FLAG_GI_ENABLED) != 0u;
  if (position.w < 0.5 || !enabled) {
    outReservoirs[index] = giReservoirEmpty();
    return;
  }

  let x = position.xyz;
  let n = textureLoad(texNormal, pixel, 0).xyz;
  let albedo = textureLoad(texAlbedo, pixel, 0).xyz;
  rngInit(pixel, uni.frame, 4u);

  var reservoir = giReservoirEmpty();

  let dir = cosineSampleHemisphere(n, rand(), rand());
  let cosTheta = dot(n, dir);
  let hit = traceScene(x + n * SURFACE_EPS, dir);
  if (hit.hit && cosTheta > 0.0) {
    // Emissive hits contribute nothing: direct light is ReSTIR DI's job, so
    // counting it again here would double the first bounce.
    let radiance = pathRadiance(hit.pos, hit.normal, hit.albedo, uni.maxBounces);
    let candidate = giReservoirSample(hit.pos, hit.normal, radiance);
    let targetPdf = giTargetPdf(x, n, albedo, candidate);
    let sourcePdf = cosTheta * INV_PI;
    giReservoirUpdate(
      &reservoir,
      hit.pos,
      hit.normal,
      radiance,
      safeDiv(targetPdf, sourcePdf),
      targetPdf,
      1.0,
      rand(),
    );
  } else {
    giSetM(&reservoir, 1.0);
  }

  let temporal = (uni.flags & FLAG_GI_TEMPORAL) != 0u;
  if (temporal && uni.accumFrames > 0u) {
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
        let prev = giReservoirCapM(
          prevReservoirs[prevPixel.y * uni.resolution.x + prevPixel.x],
          TEMPORAL_M_CAP,
        );
        let jacobian = reconnectionJacobian(
          prevPosition.xyz,
          x,
          prev.samplePos.xyz,
          prev.sampleNormal.xyz,
        );
        if (giM(prev) > 0.0 && giTarget(prev) > 0.0 && jacobian > 0.0) {
          let targetPdf = giTargetPdf(x, n, albedo, prev);
          giReservoirUpdate(
            &reservoir,
            prev.samplePos.xyz,
            prev.sampleNormal.xyz,
            prev.radiance.xyz,
            targetPdf * giReservoirWeight(prev) * jacobian * giM(prev),
            targetPdf,
            giM(prev),
            rand(),
          );
        }
      }
    }
  }

  outReservoirs[index] = reservoir;
}
