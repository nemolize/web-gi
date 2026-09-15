struct BdptReservoirPair {
  normal: BdptReplayReservoir,
  caustic: BdptReplayReservoir,
}

struct BdptLightNode {
  reservoir: BdptReplayReservoir,
  nextPixel: vec4u,
}

fn bdptStreamInitial(reservoir: ptr<function, BdptReplayReservoir>, seeds: vec4u, candidate: BdptCandidate) -> bool {
  let sample = BdptPathSample(seeds, vec4f(candidate.estimator, candidate.misWeight));
  return bdptUpdateReservoir(&(*reservoir).path, sample,
    bdptInitialWeight(seeds.y, uni.resolution.x * uni.resolution.y), 1.0, 1.0, bdptRandom());
}
