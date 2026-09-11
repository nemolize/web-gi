@group(1) @binding(0) var<storage, read> temporalReservoirs: array<BdptReservoirPair>;
@group(1) @binding(1) var<storage, read_write> finalReservoirs: array<BdptReservoirPair>;

@compute @workgroup_size(BDPT_WORKGROUP_SIZE, BDPT_WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (any(pixel >= uni.resolution)) { return; }
  let index = pixel.y * uni.resolution.x + pixel.x;
  let center = temporalReservoirs[index];
  finalReservoirs[index] = center;
  if ((uni.flags & FLAG_GI_SPATIAL) == 0u || uni.spatialSamples == 0u) { return; }
  let surface = traceScenePrimary(uni.cam.pos.xyz, primaryRayDir(uni.cam, pixelNdc(pixel)));
  if (!surface.hit || surface.materialIndex > 0u) { return; }
  rngInit(pixel, uni.frame, 47u);
  var domains: array<vec2u, 33>;
  domains[0] = pixel;
  var count = 1u;
  let radius = spatialPixelRadius(uni.cam, surfaceDepth(uni.cam, surface.pos));
  for (var attempt = 0u; attempt < min(32u, uni.spatialSamples); attempt++) {
    let offset = spatialOffset(radius, bdptRandom() * 2.0 * PI, bdptRandom());
    let coordinate = vec2i(pixel) + offset;
    if (any(coordinate < vec2i(0)) || any(coordinate >= vec2i(uni.resolution))) { continue; }
    let neighbor = vec2u(coordinate);
    var duplicate = false;
    for (var other = 0u; other < count; other++) {
      duplicate = duplicate || all(domains[other] == neighbor);
    }
    if (duplicate) { continue; }
    let hit = traceScenePrimary(uni.cam.pos.xyz, primaryRayDir(uni.cam, pixelNdc(neighbor)));
    let difference = hit.pos - surface.pos;
    let normalDistance = dot(difference, surface.normal);
    if (!hit.hit || hit.materialIndex > 0u || dot(hit.normal, surface.normal) < 0.9
      || abs(normalDistance) > 0.05 || length(difference - normalDistance * surface.normal) > uni.spatialRadius) { continue; }
    domains[count] = neighbor;
    count++;
  }
  if (count == 1u) { return; }
  var selectionState = gRngState;
  var workspace: BdptWorkspace;
  var confidence = center.normal.path.confidence;
  var output = bdptEmptyReplayReservoir(confidence);
  let lightCount = uni.resolution.x * uni.resolution.y;
  let centerConfidence = confidence / f32(min(32u, uni.spatialSamples));
  let centerTarget = center.normal.path.targetDensity;
  var centerWeight = 1.0;
  for (var sourceIndex = 1u; sourceIndex < count; sourceIndex++) {
    let sourcePixel = domains[sourceIndex];
    let source = temporalReservoirs[sourcePixel.y * uni.resolution.x + sourcePixel.x].normal;
    confidence += source.path.confidence;
    var centerPairWeight = 1.0;
    if (centerTarget > 0.0 && source.path.confidence > 0.0) {
      let inverse = bdptShiftReplay(bdptReservoirSample(center.normal), uni.cam, pixel, sourcePixel, lightCount, &workspace);
      let inverseSample = BdptPathSample(inverse.sample.techniqueSeeds,
        vec4f(inverse.evaluation.candidate.estimator, inverse.evaluation.candidate.misWeight));
      let other = bdptBalanceNumerator(source.path.confidence, bdptTarget(inverseSample), inverse.jacobian);
      centerPairWeight = bdptPairwiseWeight(centerConfidence * centerTarget, other);
    }
    centerWeight += centerPairWeight;
    if (source.path.targetDensity <= 0.0 || source.path.confidence <= 0.0) { continue; }
    let shifted = bdptShiftReplay(bdptReservoirSample(source), uni.cam, sourcePixel, pixel, lightCount, &workspace);
    if (shifted.jacobian <= 0.0) { continue; }
    let shiftedSample = BdptPathSample(shifted.sample.techniqueSeeds,
      vec4f(shifted.evaluation.candidate.estimator, shifted.evaluation.candidate.misWeight));
    let own = bdptBalanceNumerator(source.path.confidence, source.path.targetDensity, 1.0 / shifted.jacobian);
    let weight = bdptPairwiseWeight(own, centerConfidence * bdptTarget(shiftedSample)) / f32(count);
    gRngState = selectionState;
    let random = bdptRandom();
    selectionState = gRngState;
    bdptUpdateReplayReservoir(&output, shifted.sample, shifted.evaluation.candidate,
      source.path.contributionWeight, weight, shifted.jacobian, random);
  }
  gRngState = selectionState;
  let selectedCenter = bdptUpdateReservoir(&output.path, center.normal.path.sample,
    center.normal.path.contributionWeight, centerWeight / f32(count), 1.0, bdptRandom());
  if (selectedCenter) { output.coordinates = center.normal.coordinates; output.cameraReconnection = center.normal.cameraReconnection; }
  output.path.confidence = min(confidence, f32(max(1u, uni.maxHistory)));
  bdptFinalizeReservoir(&output.path);
  finalReservoirs[index] = BdptReservoirPair(output, center.caustic);
}
