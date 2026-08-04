// ReSTIR DI, stage 1: streaming RIS over fresh light candidates, then temporal
// reuse of the previous frame's reservoir found by reprojection.

@group(1) @binding(0) var texDepth: texture_2d<f32>;
@group(1) @binding(1) var texNormal: texture_2d<f32>;
@group(1) @binding(2) var texAlbedo: texture_2d<f32>;
@group(1) @binding(3) var texPrevDepth: texture_2d<f32>;
@group(1) @binding(4) var texPrevNormal: texture_2d<f32>;
@group(1) @binding(5) var<storage, read> prevReservoirs: array<DiReservoir>;
@group(1) @binding(6) var<storage, read_write> outReservoirs: array<DiReservoir>;

const PLANE_TOLERANCE: f32 = 0.02;
const NORMAL_TOLERANCE: f32 = 0.9;
/** Temporal history cap, as a multiple of the per-frame candidate count. */
const TEMPORAL_M_CAP: f32 = 20.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  let index = pixel.y * uni.resolution.x + pixel.x;

  let depth = textureLoad(texDepth, pixel, 0).x;
  let enabled = (uni.flags & FLAG_DI_ENABLED) != 0u;
  if (!surfaceHit(depth) || uni.lightCount == 0u || !enabled) {
    outReservoirs[index] = diReservoirEmpty();
    return;
  }

  let x = surfacePosition(uni.cam, pixel, depth);
  let n = textureLoad(texNormal, pixel, 0).xyz;
  let albedo = textureLoad(texAlbedo, pixel, 0).xyz;
  rngInit(pixel, uni.frame, 2u);

  var reservoir = diReservoirEmpty();
  let candidates = max(uni.diCandidates, 1u);
  for (var i = 0u; i < candidates; i = i + 1u) {
    let ls = sampleLight(rand(), rand(), rand());
    if (ls.pdfArea <= 0.0) {
      continue;
    }
    let targetPdf = diTargetPdf(x, n, albedo, ls.pos, ls.quadIndex);
    diReservoirUpdate(
      &reservoir,
      ls.pos,
      ls.quadIndex,
      targetPdf / ls.pdfArea,
      targetPdf,
      1.0,
      rand(),
    );
  }

  let temporal = (uni.flags & FLAG_DI_TEMPORAL) != 0u;
  if (temporal && uni.accumFrames > 0u) {
    let uv = projectToUv(uni.prevCam, x);
    if (uv.z > 0.5) {
      let prevPixel = min(
        vec2u(uv.xy * vec2f(uni.resolution)),
        uni.resolution - vec2u(1u, 1u),
      );
      let prevDepth = textureLoad(texPrevDepth, prevPixel, 0).x;
      let prevNormal = textureLoad(texPrevNormal, prevPixel, 0).xyz;
      let prevPosition = surfacePosition(uni.prevCam, prevPixel, prevDepth);
      let samePlane = abs(dot(prevPosition - x, n)) < PLANE_TOLERANCE;
      if (surfaceHit(prevDepth) && samePlane && dot(prevNormal, n) > NORMAL_TOLERANCE) {
        let prev = diReservoirCapM(
          prevReservoirs[prevPixel.y * uni.resolution.x + prevPixel.x],
          TEMPORAL_M_CAP * f32(candidates),
        );
        // Re-evaluate the history sample against this pixel's shading point.
        let targetPdf = diTargetPdf(x, n, albedo, prev.lightPos.xyz, prev.lightQuad);
        diReservoirUpdate(
          &reservoir,
          prev.lightPos.xyz,
          prev.lightQuad,
          targetPdf * diReservoirWeight(prev) * prev.m,
          targetPdf,
          prev.m,
          rand(),
        );
      }
    }
  }

  outReservoirs[index] = reservoir;
}
