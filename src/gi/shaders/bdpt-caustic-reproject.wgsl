@group(1) @binding(0) var<storage, read> previousReservoirs: array<BdptReservoirPair>;
@group(1) @binding(1) var<storage, read_write> temporalNodes: array<BdptTemporalNode>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (any(pixel >= uni.resolution) || uni.accumFrames == 0u || (uni.flags & FLAG_GI_TEMPORAL) == 0u || bdptCameraUnchanged()) { return; }
  let index = pixel.y * uni.resolution.x + pixel.x;
  let source = previousReservoirs[index].caustic;
  let confidence = bdptTemporalConfidence(source.path.confidence);
  if (source.path.targetDensity <= 0.0 || confidence <= 0.0) { return; }
  var workspace: BdptWorkspace;
  let shifted = bdptShiftCaustic(bdptReservoirSample(source), uni.cam,
    uni.resolution.x * uni.resolution.y, &workspace);
  if (shifted.jacobian <= 0.0) { return; }
  let destination = shifted.evaluation.candidate.pixel;
  var reservoir = source;
  reservoir.path.sample = BdptPathSample(shifted.sample.techniqueSeeds,
    vec4f(shifted.evaluation.candidate.estimator, shifted.evaluation.candidate.misWeight));
  reservoir.path.targetDensity = bdptTarget(reservoir.path.sample);
  reservoir.filmOffsetOverride = shifted.sample.filmOffsetOverride;
  temporalNodes[index].reservoir = reservoir;
  temporalNodes[index].sourceTarget = source.path.targetDensity;
  temporalNodes[index].sourceConfidence = confidence;
  temporalNodes[index].jacobian = shifted.jacobian;
  temporalNodes[index].next = atomicExchange(&temporalNodes[destination.y * uni.resolution.x + destination.x].head, index + 1u);
}
