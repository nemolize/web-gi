@group(1) @binding(0) var<storage, read> initialReservoirs: array<BdptReservoirPair>;
@group(1) @binding(1) var<storage, read> previousReservoirs: array<BdptReservoirPair>;
@group(1) @binding(2) var<storage, read_write> temporalReservoirs: array<BdptReservoirPair>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (any(pixel >= uni.resolution)) { return; }
  let index = pixel.y * uni.resolution.x + pixel.x;
  let current = initialReservoirs[index];
  if (uni.accumFrames == 0u || (uni.flags & FLAG_GI_TEMPORAL) == 0u) {
    temporalReservoirs[index] = current;
    return;
  }
  rngInit(pixel, uni.frame, 43u);
  let previous = previousReservoirs[index];
  let limit = f32(max(1u, uni.maxHistory) - 1u);
  temporalReservoirs[index] = BdptReservoirPair(
    bdptTemporalReservoir(current.normal, previous.normal, limit, bdptRandom()),
    bdptTemporalReservoir(current.caustic, previous.caustic, limit, bdptRandom()),
  );
}
