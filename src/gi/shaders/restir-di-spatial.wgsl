// ReSTIR DI, stage 2: spatial reuse with the 1/Z bias correction
// (Bitterli et al. 2020, Algorithm 6) evaluated without visibility.

@group(1) @binding(0) var texPosition: texture_2d<f32>;
@group(1) @binding(1) var texNormal: texture_2d<f32>;
@group(1) @binding(2) var texAlbedo: texture_2d<f32>;
@group(1) @binding(3) var<storage, read> srcReservoirs: array<DiReservoir>;
@group(1) @binding(4) var<storage, read_write> dstReservoirs: array<DiReservoir>;

const MAX_CONTRIBUTORS: u32 = 9u;
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
  let enabled = (uni.flags & FLAG_DI_ENABLED) != 0u;
  if (position.w < 0.5 || uni.lightCount == 0u || !enabled) {
    dstReservoirs[index] = diReservoirEmpty();
    return;
  }

  let x = position.xyz;
  let n = textureLoad(texNormal, pixel, 0).xyz;
  let albedo = textureLoad(texAlbedo, pixel, 0).xyz;
  rngInit(pixel, uni.frame, 3u);

  var contributors: array<vec2u, MAX_CONTRIBUTORS>;
  var contributorM: array<f32, MAX_CONTRIBUTORS>;
  var contributorCount = 0u;

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
  contributors[0] = pixel;
  contributorM[0] = center.m;
  contributorCount = 1u;

  // Always dispatched so the final reservoir lands in the same buffer either
  // way; disabling spatial reuse simply degenerates it to a 1/Z pass-through.
  let spatial = (uni.flags & FLAG_DI_SPATIAL) != 0u;
  let wanted = select(0u, min(uni.spatialSamples, MAX_CONTRIBUTORS - 1u), spatial);
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
    let neighborPosition = textureLoad(texPosition, neighbor, 0);
    let neighborNormal = textureLoad(texNormal, neighbor, 0).xyz;
    if (neighborPosition.w < 0.5
      || dot(neighborNormal, n) < NORMAL_TOLERANCE
      || abs(dot(neighborPosition.xyz - x, n)) > PLANE_TOLERANCE) {
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
    contributors[contributorCount] = neighbor;
    contributorM[contributorCount] = other.m;
    contributorCount = contributorCount + 1u;
  }

  // 1/Z correction: only contributors that could have produced the surviving
  // sample are allowed to count towards its normalisation.
  var z = 0.0;
  for (var i = 0u; i < contributorCount; i = i + 1u) {
    let coord = contributors[i];
    let contributorPosition = textureLoad(texPosition, coord, 0);
    let contributorNormal = textureLoad(texNormal, coord, 0).xyz;
    let contributorAlbedo = textureLoad(texAlbedo, coord, 0).xyz;
    let pdf = diTargetPdf(
      contributorPosition.xyz,
      contributorNormal,
      contributorAlbedo,
      reservoir.lightPos.xyz,
      reservoir.lightQuad,
    );
    if (pdf > 0.0) {
      z += contributorM[i];
    }
  }
  reservoir.m = z;

  dstReservoirs[index] = reservoir;
}
