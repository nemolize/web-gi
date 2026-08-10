// ReSTIR GI, stage 2: spatial reuse. Each reused sample point is re-weighted
// through the reconnection Jacobian, and the neighbours resample among
// themselves before one visibility ray decides whether their winner may join
// this pixel — which is what keeps light from leaking through the block
// geometry.

@group(1) @binding(0) var texDepth: texture_2d<f32>;
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

  let depth = textureLoad(texDepth, pixel, 0).x;
  let enabled = (uni.flags & FLAG_GI_ENABLED) != 0u;
  if (!surfaceHit(depth) || !enabled) {
    dstReservoirs[index] = giReservoirEmpty();
    return;
  }

  let x = surfacePosition(uni.cam, pixel, depth);
  let n = textureLoad(texNormal, pixel, 0).xyz;
  let albedo = textureLoad(texAlbedo, pixel, 0).xyz;
  rngInit(pixel, uni.frame, 5u);

  // Neighbours only, coordinates packed, `M` re-read rather than memoised —
  // see `restir-di-spatial.wgsl` for why.
  var neighbors: array<u32, MAX_NEIGHBORS>;
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
  // The neighbours resample into their own reservoir first, so one visibility
  // ray settles the whole group instead of one per candidate. Reservoir merging
  // is associative, so folding the group in with its own `wSum` and `M`
  // reproduces what folding each neighbour directly would have produced.
  var group = giReservoirEmpty();

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
    let neighborDepth = textureLoad(texDepth, neighbor, 0).x;
    let neighborNormal = textureLoad(texNormal, neighbor, 0).xyz;
    let neighborPosition = surfacePosition(uni.cam, neighbor, neighborDepth);
    if (!surfaceHit(neighborDepth)
      || dot(neighborNormal, n) < NORMAL_TOLERANCE
      || abs(dot(neighborPosition - x, n)) > PLANE_TOLERANCE) {
      continue;
    }

    let other = srcReservoirs[neighbor.y * uni.resolution.x + neighbor.x];
    if (giM(other) <= 0.0 || giTarget(other) <= 0.0) {
      continue;
    }
    let targetPdf = giTargetPdf(x, n, albedo, other);
    if (targetPdf <= 0.0) {
      continue;
    }
    let jacobian = reconnectionJacobian(
      neighborPosition,
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
      &group,
      other.samplePos.xyz,
      other.sampleNormal.xyz,
      other.radiance.xyz,
      targetPdf * giReservoirWeight(other) * jacobian * giM(other),
      targetPdf,
      giM(other),
      rand(),
    );
    neighbors[neighborCount] = packPixel(neighbor);
    neighborCount = neighborCount + 1u;
  }

  // One ray, on the sample that actually survived the group's resampling. An
  // occluded winner drops the group rather than the pixel: the centre sample
  // was folded in before this and is never at risk, so there is no path that
  // zeroes a pixel outright.
  // A group that carries no weight has no sample to test: folding it in still
  // passes on the `M` its neighbours contributed, which is what they did
  // one by one before.
  let groupVisible =
    giWSum(group) <= 0.0 || mutuallyVisible(x, n, group.samplePos.xyz);
  if (groupVisible) {
    giReservoirUpdate(
      &reservoir,
      group.samplePos.xyz,
      group.sampleNormal.xyz,
      group.radiance.xyz,
      giWSum(group),
      giTarget(group),
      giM(group),
      rand(),
    );
  } else {
    neighborCount = 0u;
  }

  // The support test deliberately does NOT apply the Jacobian gate: the gate is
  // this pass's own conservatism about transferring a sample, not a statement
  // that the contributor's domain excludes it. Gating here shrinks Z and
  // incorrectly raises the normalised result.
  // This pixel is the first contributor and its surface never left registers.
  var z = 0.0;
  if (giSupported(x, n, albedo, reservoir)) {
    z += giM(center);
  }
  for (var i = 0u; i < neighborCount; i = i + 1u) {
    let coord = unpackPixel(neighbors[i]);
    let contributorDepth = textureLoad(texDepth, coord, 0).x;
    let contributorNormal = textureLoad(texNormal, coord, 0).xyz;
    let contributorAlbedo = textureLoad(texAlbedo, coord, 0).xyz;
    let contributorPosition = surfacePosition(uni.cam, coord, contributorDepth);
    if (giSupported(
      contributorPosition,
      contributorNormal,
      contributorAlbedo,
      reservoir,
    )) {
      z += giM(srcReservoirs[coord.y * uni.resolution.x + coord.x]);
    }
  }
  giSetM(&reservoir, z);

  dstReservoirs[index] = reservoir;
}
