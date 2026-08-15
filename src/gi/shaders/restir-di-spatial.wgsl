// ReSTIR DI, stage 2: spatial reuse with the 1/Z bias correction
// (Bitterli et al. 2020, Algorithm 6) evaluated without visibility.

@group(1) @binding(0) var texDepth: texture_2d<f32>;
@group(1) @binding(1) var texNormal: texture_2d<f32>;
@group(1) @binding(2) var texAlbedo: texture_2d<f32>;
@group(1) @binding(3) var<storage, read> srcReservoirs: array<DiReservoir>;
@group(1) @binding(4) var<storage, read_write> dstReservoirs: array<DiReservoir>;

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
  let enabled = (uni.flags & FLAG_DI_ENABLED) != 0u;
  if (!surfaceHit(depth) || uni.lightCount == 0u || !enabled) {
    dstReservoirs[index] = diReservoirEmpty();
    return;
  }

  let x = surfacePosition(uni.cam, pixel, depth);
  let packedNormal = textureLoad(texNormal, pixel, 0);
  if (abs(packedNormal.w) > 0.5) {
    dstReservoirs[index] = diReservoirEmpty();
    return;
  }
  let n = packedNormal.xyz;
  let albedo = textureLoad(texAlbedo, pixel, 0).xyz;
  rngInit(pixel, uni.frame, 3u);

  // Only the neighbours are recorded: this pixel is always a contributor, and
  // its surface is already in registers. The array is dynamically indexed, so
  // it lands in per-thread scratch; packing coordinates into one u32 and
  // re-reading `M` from the reservoir in the 1/Z loop rather than memoising it
  // both shrink that footprint. Aimed at occupancy, which the device A/B did
  // not confirm — it credits the win to the merged compute pass instead.
  var neighbors: array<u32, MAX_NEIGHBORS>;
  var neighborCount = 0u;

  let center = srcReservoirs[index];
  var reservoir = diReservoirEmpty();
  diReservoirUpdate(
    &reservoir,
    center.lightPos.xyz,
    center.lightQuad,
    center.targetPdf * diReservoirWeight(center) * center.m,
    center.targetPdf,
    center.m,
    rand(),
  );
  // Always dispatched so the final reservoir lands in the same buffer either
  // way; disabling spatial reuse simply degenerates it to a 1/Z pass-through.
  let spatial = (uni.flags & FLAG_DI_SPATIAL) != 0u;
  let wanted = select(0u, min(uni.spatialSamples, MAX_NEIGHBORS), spatial);
  for (var i = 0u; i < wanted; i = i + 1u) {
    let angle = rand() * 2.0 * PI;
    let radius = uni.spatialRadius * sqrt(rand());
    let offset = vec2i(i32(cos(angle) * radius), i32(sin(angle) * radius));
    let coord = vec2i(pixel) + offset;
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
    if (other.m <= 0.0) {
      continue;
    }
    // The neighbour's sample is re-weighted against this pixel's surface.
    let targetPdf = diTargetPdf(x, n, albedo, other.lightPos.xyz, other.lightQuad);
    diReservoirUpdate(
      &reservoir,
      other.lightPos.xyz,
      other.lightQuad,
      targetPdf * diReservoirWeight(other) * other.m,
      targetPdf,
      other.m,
      rand(),
    );
    neighbors[neighborCount] = packPixel(neighbor);
    neighborCount = neighborCount + 1u;
  }

  // 1/Z correction: only contributors that could have produced the surviving
  // sample are allowed to count towards its normalisation. This pixel is the
  // first contributor and its surface never left registers.
  var z = 0.0;
  if (diSupported(x, n, albedo, reservoir.lightPos.xyz, reservoir.lightQuad)) {
    z += center.m;
  }
  for (var i = 0u; i < neighborCount; i = i + 1u) {
    let coord = unpackPixel(neighbors[i]);
    let contributorDepth = textureLoad(texDepth, coord, 0).x;
    let contributorNormal = textureLoad(texNormal, coord, 0).xyz;
    let contributorAlbedo = textureLoad(texAlbedo, coord, 0).xyz;
    let contributorPosition = surfacePosition(uni.cam, coord, contributorDepth);
    if (diSupported(
      contributorPosition,
      contributorNormal,
      contributorAlbedo,
      reservoir.lightPos.xyz,
      reservoir.lightQuad,
    )) {
      z += srcReservoirs[coord.y * uni.resolution.x + coord.x].m;
    }
  }
  reservoir.m = z;

  dstReservoirs[index] = reservoir;
}
