@group(1) @binding(0) var<storage, read> cameraReservoirs: array<BdptReplayReservoir>;
@group(1) @binding(1) var<storage, read> lightHeads: array<u32>;
@group(1) @binding(2) var<storage, read> lightNodes: array<BdptLightNode>;
@group(1) @binding(3) var<storage, read_write> initialReservoirs: array<BdptReservoirPair>;

fn bdptSumReservoir(output: ptr<function, BdptReplayReservoir>, input: ptr<function, BdptReplayReservoir>) {
  if (bdptUpdateReservoir(&(*output).path, (*input).path.sample, (*input).path.contributionWeight, 1.0, 1.0, bdptRandom())) {
    (*output).coordinates = (*input).coordinates;
    (*output).cameraReconnection = (*input).cameraReconnection;
  }
}

@compute @workgroup_size(BDPT_WORKGROUP_SIZE, BDPT_WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid.xy >= bdptDispatchRegion.extent)) { return; }
  let pixel = gid.xy + bdptDispatchRegion.origin;
  if (any(pixel >= uni.resolution)) { return; }
  let index = pixel.y * uni.resolution.x + pixel.x;
  rngInit(pixel, uni.frame, 41u);
  var pair = BdptReservoirPair(bdptEmptyReplayReservoir(1.0), bdptEmptyReplayReservoir(1.0));
  var input = cameraReservoirs[index];
  bdptSumReservoir(&pair.normal, &input);
  var node = lightHeads[index * 2u];
  while (node != 0u) {
    input = lightNodes[node - 1u].reservoir;
    bdptSumReservoir(&pair.normal, &input);
    node = lightNodes[node - 1u].nextPixel.x;
  }
  node = lightHeads[index * 2u + 1u];
  while (node != 0u) {
    input = lightNodes[node - 1u].reservoir;
    bdptSumReservoir(&pair.caustic, &input);
    node = lightNodes[node - 1u].nextPixel.x;
  }
  bdptFinalizeReservoir(&pair.normal.path);
  bdptFinalizeReservoir(&pair.caustic.path);
  initialReservoirs[index] = pair;
}
