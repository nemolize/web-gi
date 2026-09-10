struct BdptPathSample {
  techniqueSeeds: vec4u,
  contributionMis: vec4f,
}

struct BdptPathReservoir {
  sample: BdptPathSample,
  weightSum: f32,
  contributionWeight: f32,
  confidence: f32,
  targetDensity: f32,
}

struct BdptMisSum {
  maximum: f32,
  scaledSum: f32,
}

fn bdptTarget(sample: BdptPathSample) -> f32 {
  return dot(sample.contributionMis.xyz, vec3f(0.2126, 0.7152, 0.0722))
    * sample.contributionMis.w;
}

fn bdptInitialWeight(cameraVertices: u32, lightSubpathCount: u32) -> f32 {
  if (cameraVertices > 1u) {
    return 1.0;
  }
  if (lightSubpathCount == 0u) {
    return 0.0;
  }
  return 1.0 / f32(lightSubpathCount);
}

fn bdptEmptyReservoir(confidence: f32) -> BdptPathReservoir {
  var reservoir: BdptPathReservoir;
  reservoir.confidence = confidence;
  return reservoir;
}

fn bdptUpdateReservoir(
  reservoir: ptr<function, BdptPathReservoir>,
  sample: BdptPathSample,
  contributionWeight: f32,
  resamplingWeight: f32,
  forwardJacobian: f32,
  random: f32,
) {
  let targetDensity = bdptTarget(sample);
  let weight = targetDensity * contributionWeight * resamplingWeight * forwardJacobian;
  if (!(weight > 0.0) || weight > 3.402823e38) {
    return;
  }
  (*reservoir).weightSum += weight;
  if (random * (*reservoir).weightSum < weight) {
    (*reservoir).sample = sample;
    (*reservoir).targetDensity = targetDensity;
  }
}

fn bdptFinalizeReservoir(reservoir: ptr<function, BdptPathReservoir>) {
  (*reservoir).contributionWeight = 0.0;
  if ((*reservoir).targetDensity > 0.0) {
    (*reservoir).contributionWeight = (*reservoir).weightSum / (*reservoir).targetDensity;
  }
}

fn bdptReservoirRadiance(reservoir: BdptPathReservoir) -> vec3f {
  return reservoir.sample.contributionMis.xyz
    * reservoir.sample.contributionMis.w * reservoir.contributionWeight;
}

fn bdptBalanceNumerator(confidence: f32, sourceTarget: f32, inverseJacobian: f32) -> f32 {
  return confidence * sourceTarget * inverseJacobian;
}

fn bdptAccumulateMis(
  sum: ptr<function, BdptMisSum>,
  logRelativeDensity: f32,
  sampleCount: u32,
  supported: bool,
) {
  if (!supported || sampleCount == 0u) {
    return;
  }
  let score = 2.0 * (logRelativeDensity + log(f32(sampleCount)));
  if ((*sum).scaledSum == 0.0) {
    (*sum).maximum = score;
    (*sum).scaledSum = 1.0;
    return;
  }
  let maximum = max((*sum).maximum, score);
  (*sum).scaledSum = (*sum).scaledSum * exp((*sum).maximum - maximum)
    + exp(score - maximum);
  (*sum).maximum = maximum;
}

fn bdptMisWeight(sum: BdptMisSum, logRelativeDensity: f32, sampleCount: u32, supported: bool) -> f32 {
  if (!supported || sampleCount == 0u || sum.scaledSum == 0.0) {
    return 0.0;
  }
  return exp(2.0 * (logRelativeDensity + log(f32(sampleCount))) - sum.maximum)
    / sum.scaledSum;
}
