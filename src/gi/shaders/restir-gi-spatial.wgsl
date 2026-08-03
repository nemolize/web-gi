// ReSTIR GI, stage 2: spatial reuse. Each reused sample point is re-weighted
// through the reconnection Jacobian and rejected when it is not visible from
// this pixel's shading point, which is what keeps light from leaking through
// the block geometry.

@group(1) @binding(0) var texPosition: texture_2d<f32>;
@group(1) @binding(1) var texNormal: texture_2d<f32>;
@group(1) @binding(2) var texAlbedo: texture_2d<f32>;
@group(1) @binding(3) var<storage, read> srcReservoirs: array<GiReservoir>;
@group(1) @binding(4) var<storage, read_write> dstReservoirs: array<GiReservoir>;

const MAX_NEIGHBORS: u32 = 8u;
const PLANE_TOLERANCE: f32 = 0.05;
const NORMAL_TOLERANCE: f32 = 0.9;

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
    dstReservoirs[index] = giReservoirEmpty();
    return;
  }

  let x = position.xyz;
  let n = textureLoad(texNormal, pixel, 0).xyz;
  let albedo = textureLoad(texAlbedo, pixel, 0).xyz;
  rngInit(pixel, uni.frame, 5u);

  // See `restir-di-spatial.wgsl`: neighbours only, coordinates packed, because
  // a dynamically-indexed array lands in per-thread scratch.
  var neighbors: array<u32, MAX_NEIGHBORS>;
  var neighborM: array<f32, MAX_NEIGHBORS>;
  var neighborCount = 0u;

  let center = srcReservoirs[index];
  var reservoir = giReservoirEmpty();
  giReservoirUpdate(
    &reservoir,
    center.samplePos.xyz,
    center.sampleNormal.xyz,
    center.radiance.xyz,
    giTarget(center) * giReservoirWeight(center) * giM(center),
    giTarget(center),
    giM(center),
    rand(),
  );
  // Always dispatched so the final reservoir lands in the same buffer either
  // way; disabling spatial reuse simply degenerates it to a 1/Z pass-through.
  let spatial = (uni.flags & FLAG_GI_SPATIAL) != 0u;
  let wanted = select(0u, min(uni.spatialSamples, MAX_NEIGHBORS), spatial);
  for (var i = 0u; i < wanted; i = i + 1u) {
    let angle = rand() * 2.0 * PI;
    let radius = uni.spatialRadius * sqrt(rand());
    let coord = vec2i(pixel) + vec2i(i32(cos(angle) * radius), i32(sin(angle) * radius));
    if (coord.x < 0 || coord.y < 0
      || coord.x >= i32(uni.resolution.x) || coord.y >= i32(uni.resolution.y)) {
      continue;
    }
    let neighbor = vec2u(coord);
    let neighborPosition = textureLoad(texPosition, neighbor, 0);
    let neighborNormal = textureLoad(texNormal, neighbor, 0).xyz;
    if (neighborPosition.w < 0.5
      || dot(neighborNormal, n) < NORMAL_TOLERANCE
      || abs(dot(neighborPosition.xyz - x, n)) > PLANE_TOLERANCE) {
      continue;
    }

    let other = srcReservoirs[neighbor.y * uni.resolution.x + neighbor.x];
    if (giM(other) <= 0.0 || giTarget(other) <= 0.0) {
      continue;
    }
    let targetPdf = giTargetPdf(x, n, albedo, other);
    if (targetPdf <= 0.0 || !mutuallyVisible(x, n, other.samplePos.xyz)) {
      continue;
    }
    let jacobian = reconnectionJacobian(
      neighborPosition.xyz,
      x,
      other.samplePos.xyz,
      other.sampleNormal.xyz,
    );
    // A rejected shift drops the neighbour outright: folding it in with a zero
    // weight would still raise M and Z, darkening the pixel instead.
    if (jacobian <= 0.0) {
      continue;
    }
    giReservoirUpdate(
      &reservoir,
      other.samplePos.xyz,
      other.sampleNormal.xyz,
      other.radiance.xyz,
      targetPdf * giReservoirWeight(other) * jacobian * giM(other),
      targetPdf,
      giM(other),
      rand(),
    );
    neighbors[neighborCount] = packPixel(neighbor);
    neighborM[neighborCount] = giM(other);
    neighborCount = neighborCount + 1u;
  }

  // The support test deliberately does NOT apply the Jacobian gate: the gate is
  // this pass's own conservatism about transferring a sample, not a statement
  // that the contributor's domain excludes it. Gating here shrinks Z and
  // measured 6% brighter than the reference path tracer, against 1% without.
  // This pixel is the first contributor and its surface never left registers.
  var z = 0.0;
  if (giTargetPdf(x, n, albedo, reservoir) > 0.0) {
    z += giM(center);
  }
  for (var i = 0u; i < neighborCount; i = i + 1u) {
    let coord = unpackPixel(neighbors[i]);
    let contributorPosition = textureLoad(texPosition, coord, 0);
    let contributorNormal = textureLoad(texNormal, coord, 0).xyz;
    let contributorAlbedo = textureLoad(texAlbedo, coord, 0).xyz;
    let pdf = giTargetPdf(
      contributorPosition.xyz,
      contributorNormal,
      contributorAlbedo,
      reservoir,
    );
    if (pdf > 0.0) {
      z += neighborM[i];
    }
  }
  giSetM(&reservoir, z);

  dstReservoirs[index] = reservoir;
}
