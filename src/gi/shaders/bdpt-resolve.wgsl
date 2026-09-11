@group(1) @binding(0) var<storage, read> reservoirs: array<BdptReservoirPair>;
@group(1) @binding(1) var output: texture_storage_2d<rgba16float, write>;

fn bdptRadiance(reservoir: BdptReplayReservoir) -> vec3f {
  return reservoir.path.sample.contributionMis.xyz * reservoir.path.sample.contributionMis.w * reservoir.path.contributionWeight;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid.xy >= uni.resolution)) { return; }
  let pair = reservoirs[gid.y * uni.resolution.x + gid.x];
  textureStore(output, gid.xy, vec4f(min(bdptRadiance(pair.normal) + bdptRadiance(pair.caustic), vec3f(65504.0)), 1.0));
}
