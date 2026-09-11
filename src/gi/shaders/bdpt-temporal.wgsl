@group(1) @binding(0) var<storage, read> initialReservoirs: array<BdptReservoirPair>;
@group(1) @binding(1) var<storage, read> previousReservoirs: array<BdptReservoirPair>;
@group(1) @binding(2) var<storage, read_write> temporalReservoirs: array<BdptReservoirPair>;
@group(1) @binding(3) var<storage, read_write> temporalNodes: array<BdptTemporalNode>;

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
  if (bdptCameraUnchanged()) {
    let previous = previousReservoirs[index];
    let limit = f32(max(1u, uni.maxHistory) - 1u);
    temporalReservoirs[index] = BdptReservoirPair(
      bdptTemporalReservoir(current.normal, previous.normal, limit, bdptRandom()),
      bdptTemporalReservoir(current.caustic, previous.caustic, limit, bdptRandom()));
    return;
  }
  var selectionState = gRngState;
  let lightCount = uni.resolution.x * uni.resolution.y;
  var workspace: BdptWorkspace;
  var output = current;
  var proxyConfidence = 0.0;
  let hit = traceScenePrimary(uni.cam.pos.xyz, primaryRayDir(uni.cam, pixelNdc(pixel)));
  let projection = bdptProjectToCamera(uni.prevCam, hit.pos, hit.normal);
  if (hit.hit && hit.materialIndex == 0u && projection.valid && bdptCameraVisible(uni.prevCam, hit.pos)) {
    let previousPixel = projection.pixel;
    let previous = previousReservoirs[previousPixel.y * uni.resolution.x + previousPixel.x];
    proxyConfidence = bdptTemporalConfidence(previous.caustic.path.confidence);
    let confidence = bdptTemporalConfidence(previous.normal.path.confidence);
    var merged = bdptEmptyReplayReservoir(current.normal.path.confidence + confidence);
    var weight = 1.0;
    if (current.normal.path.targetDensity > 0.0 && confidence > 0.0) {
      let inverse = bdptShiftBetweenCameras(bdptReservoirSample(current.normal), uni.cam, uni.prevCam,
        pixel, previousPixel, lightCount, &workspace);
      weight = bdptPairwiseWeight(current.normal.path.confidence * current.normal.path.targetDensity,
        confidence * bdptReplayTarget(inverse.evaluation, inverse.sample) * inverse.jacobian);
    }
    if (bdptUpdateReservoir(&merged.path, current.normal.path.sample, current.normal.path.contributionWeight, weight, 1.0, 0.0)) {
      merged.coordinates = current.normal.coordinates;
      merged.cameraReconnection = current.normal.cameraReconnection;
    }
    if (previous.normal.path.targetDensity > 0.0 && confidence > 0.0) {
      let shifted = bdptShiftBetweenCameras(bdptReservoirSample(previous.normal), uni.prevCam, uni.cam,
        previousPixel, pixel, lightCount, &workspace);
      if (shifted.jacobian > 0.0) {
        weight = bdptPairwiseWeight(confidence * previous.normal.path.targetDensity / shifted.jacobian,
          current.normal.path.confidence * bdptReplayTarget(shifted.evaluation, shifted.sample));
        gRngState = selectionState;
        let random = bdptRandom();
        selectionState = gRngState;
        bdptUpdateReplayReservoir(&merged, shifted.sample, shifted.evaluation.candidate,
          previous.normal.path.contributionWeight, weight, shifted.jacobian, random);
      }
    }
    bdptFinalizeReservoir(&merged.path);
    output.normal = merged;
  }
  var caustic = bdptEmptyReplayReservoir(current.caustic.path.confidence + proxyConfidence);
  var weight = 1.0;
  if (current.caustic.path.targetDensity > 0.0) {
    let inverse = bdptShiftCaustic(bdptReservoirSample(current.caustic), uni.prevCam, lightCount, &workspace);
    if (inverse.jacobian > 0.0) {
      let previousPixel = inverse.evaluation.candidate.pixel;
      let confidence = bdptTemporalConfidence(previousReservoirs[previousPixel.y * uni.resolution.x + previousPixel.x].caustic.path.confidence);
      weight = bdptPairwiseWeight(current.caustic.path.confidence * current.caustic.path.targetDensity,
        confidence * bdptReplayTarget(inverse.evaluation, inverse.sample) * inverse.jacobian);
    }
  }
  if (bdptUpdateReservoir(&caustic.path, current.caustic.path.sample, current.caustic.path.contributionWeight, weight, 1.0, 0.0)) {
    caustic.coordinates = current.caustic.coordinates;
    caustic.cameraReconnection = current.caustic.cameraReconnection;
  }
  var node = atomicLoad(&temporalNodes[index].head);
  while (node != 0u) {
    let source = temporalNodes[node - 1u].reservoir;
    let sourceTarget = temporalNodes[node - 1u].sourceTarget;
    let sourceConfidence = temporalNodes[node - 1u].sourceConfidence;
    let jacobian = temporalNodes[node - 1u].jacobian;
    weight = bdptPairwiseWeight(sourceConfidence * sourceTarget / jacobian,
      current.caustic.path.confidence * source.path.targetDensity);
    gRngState = selectionState;
    let random = bdptRandom();
    selectionState = gRngState;
    if (bdptUpdateReservoir(&caustic.path, source.path.sample, source.path.contributionWeight, weight, jacobian, random)) {
      caustic.coordinates = source.coordinates;
      caustic.cameraReconnection = source.cameraReconnection;
    }
    node = temporalNodes[node - 1u].next;
  }
  bdptFinalizeReservoir(&caustic.path);
  output.caustic = caustic;
  temporalReservoirs[index] = output;
}
