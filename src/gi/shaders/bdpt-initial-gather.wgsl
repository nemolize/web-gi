@group(1) @binding(0) var<storage, read> cameraReservoirs: array<BdptReplayReservoir>;
@group(1) @binding(1) var<storage, read> lightHeads: array<u32>;
@group(1) @binding(2) var<storage, read> lightNodes: array<BdptLightNode>;
@group(1) @binding(3) var<storage, read_write> initialReservoirs: array<BdptReservoirPair>;

fn bdptSumReservoir(output: ptr<function, BdptReplayReservoir>, input: BdptReplayReservoir) {
  if (bdptUpdateReservoir(&(*output).path, input.path.sample, input.path.contributionWeight, 1.0, 1.0, bdptRandom())) {
    (*output).coordinates = input.coordinates;
    (*output).cameraReconnection = input.cameraReconnection;
  }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (any(pixel >= uni.resolution)) { return; }
  let index = pixel.y * uni.resolution.x + pixel.x;
  rngInit(pixel, uni.frame, 41u);
  var pair = BdptReservoirPair(bdptEmptyReplayReservoir(1.0), bdptEmptyReplayReservoir(1.0));
  bdptSumReservoir(&pair.normal, cameraReservoirs[index]);
  var node = lightHeads[index * 2u];
  while (node != 0u) {
    let input = lightNodes[node - 1u];
    bdptSumReservoir(&pair.normal, input.reservoir);
    node = input.nextPixel.x;
  }
  node = lightHeads[index * 2u + 1u];
  while (node != 0u) {
    let input = lightNodes[node - 1u];
    bdptSumReservoir(&pair.caustic, input.reservoir);
    node = input.nextPixel.x;
  }
  bdptFinalizeReservoir(&pair.normal.path);
  bdptFinalizeReservoir(&pair.caustic.path);
  initialReservoirs[index] = pair;
}
