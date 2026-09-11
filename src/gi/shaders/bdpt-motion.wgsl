struct BdptTemporalNode {
  reservoir: BdptReplayReservoir,
  sourceTarget: f32,
  sourceConfidence: f32,
  jacobian: f32,
  scorePadding: f32,
  head: atomic<u32>,
  next: u32,
  padding: vec2u,
}

fn bdptCameraUnchanged() -> bool {
  return all(uni.cam.pos == uni.prevCam.pos) && all(uni.cam.right == uni.prevCam.right)
    && all(uni.cam.up == uni.prevCam.up) && all(uni.cam.forward == uni.prevCam.forward);
}

fn bdptTemporalConfidence(value: f32) -> f32 {
  return min(value, f32(max(1u, uni.maxHistory) - 1u));
}

fn bdptReplayTarget(evaluation: BdptReplayEvaluation, sample: BdptReplaySample) -> f32 {
  return bdptTarget(BdptPathSample(sample.techniqueSeeds,
    vec4f(evaluation.candidate.estimator, evaluation.candidate.misWeight)));
}
