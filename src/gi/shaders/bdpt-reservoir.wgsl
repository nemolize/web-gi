struct BdptReplayReservoir {
  path: BdptPathReservoir,
  filmOffsetOverride: vec4f,
}

fn bdptEmptyReplayReservoir(confidence: f32) -> BdptReplayReservoir {
  return BdptReplayReservoir(bdptEmptyReservoir(confidence), vec4f(0.0));
}

fn bdptReservoirSample(reservoir: BdptReplayReservoir) -> BdptReplaySample {
  return BdptReplaySample(reservoir.path.sample.techniqueSeeds, reservoir.filmOffsetOverride);
}

fn bdptUpdateReplayReservoir(
  reservoir: ptr<function, BdptReplayReservoir>,
  sample: BdptReplaySample,
  candidate: BdptCandidate,
  contributionWeight: f32,
  resamplingWeight: f32,
  jacobian: f32,
  random: f32,
) {
  let pathSample = BdptPathSample(sample.techniqueSeeds, vec4f(candidate.estimator, candidate.misWeight));
  if (bdptUpdateReservoir(&(*reservoir).path, pathSample, contributionWeight, resamplingWeight, jacobian, random)) {
    (*reservoir).filmOffsetOverride = sample.filmOffsetOverride;
  }
}

fn bdptMergeSameDomain(
  output: ptr<function, BdptReplayReservoir>,
  input: BdptReplayReservoir,
  totalConfidence: f32,
  random: f32,
) {
  if (totalConfidence <= 0.0) {
    return;
  }
  if (bdptUpdateReservoir(&(*output).path, input.path.sample, input.path.contributionWeight,
    input.path.confidence / totalConfidence, 1.0, random)) {
    (*output).filmOffsetOverride = input.filmOffsetOverride;
  }
}

fn bdptTemporalReservoir(
  current: BdptReplayReservoir,
  previous: BdptReplayReservoir,
  maximumPreviousConfidence: f32,
  random: f32,
) -> BdptReplayReservoir {
  var history = previous;
  history.path.confidence = min(history.path.confidence, max(0.0, maximumPreviousConfidence));
  let confidence = current.path.confidence + history.path.confidence;
  var output = bdptEmptyReplayReservoir(confidence);
  bdptMergeSameDomain(&output, current, confidence, 0.0);
  bdptMergeSameDomain(&output, history, confidence, random);
  bdptFinalizeReservoir(&output.path);
  return output;
}
