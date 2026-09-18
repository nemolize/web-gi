export const TRACE_ROWS = 33;
export const TRACE_SLOTS = 8;
export const TRACE_BYTES = TRACE_ROWS * TRACE_SLOTS * 16;

export const instrumentSpatialWeights = (
  source: string,
  pixel: { x: number; y: number },
) => {
  if (
    ![pixel.x, pixel.y].every(
      (value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    )
  )
    throw new Error("Invalid trace pixel.");
  const insert = (marker: string, extra: string, occurrences = 1) => {
    if (source.split(marker).length !== occurrences + 1)
      throw new Error(`Spatial trace marker missing or repeated: ${marker}`);
    source = source.replaceAll(marker, `${marker}\n${extra}`);
  };
  insert(
    "  let index = pixel.y * uni.resolution.x + pixel.x;",
    `  weightTraceEnabled = all(pixel == vec2u(${pixel.x}u, ${pixel.y}u));`,
  );
  insert(
    "  let center = temporalReservoirs[index];",
    `
  weightTraceU(0u, 0u, center.normal.path.sample.techniqueSeeds);
  weightTraceF(0u, 1u, vec4f(center.normal.path.confidence, center.normal.path.targetDensity, center.normal.path.contributionWeight, center.normal.path.weightSum));
  weightTraceU(0u, 2u, vec4u(pixel, 0u, 0u));`,
  );
  insert("  if (count == 1u) { return; }", "");
  source = source.replace(
    "  if (count == 1u)",
    "  weightTraceU(0u, 2u, vec4u(pixel, count, gRngState));\n  if (count == 1u)",
  );
  insert(
    "    preparedCenter = bdptPrepareShift(bdptReservoirSample(center.normal), uni.cam, pixel, lightCount, &workspace);",
    `
    weightTraceF(0u, 3u, vec4f(f32(preparedCenter.connection), preparedCenter.pdf, preparedCenter.evaluation.candidate.misWeight, maxComponent(preparedCenter.evaluation.candidate.estimator)));`,
  );
  const candidate = source.includes("bdptApplyPreparedShift(preparedCenter,");
  insert(
    "    let source = temporalReservoirs[sourcePixel.y * uni.resolution.x + sourcePixel.x].normal;",
    `
    weightTraceU(sourceIndex, 0u, vec4u(sourcePixel, 1u, selectionState));
    weightTraceF(sourceIndex, 1u, vec4f(source.path.confidence, source.path.targetDensity, source.path.contributionWeight, centerConfidence));`,
    candidate ? 2 : 1,
  );
  // Candidate visits each row twice; OR flags preserve its inverse-stage evidence.
  source = source.replaceAll(
    "weightTraceU(sourceIndex, 0u, vec4u(sourcePixel, 1u, selectionState));",
    "weightTraceNeighbor(sourceIndex, sourcePixel, selectionState);",
  );
  insert(
    "      let other = bdptBalanceNumerator(source.path.confidence, bdptTarget(inverseSample), inverse.jacobian);",
    `
      weightTraceFlag(sourceIndex, 2u);
      weightTraceF(sourceIndex, 2u, vec4f(inverse.evaluation.candidate.estimator, inverse.jacobian));
      weightTraceF(sourceIndex, 3u, vec4f(bdptTarget(inverseSample), other, 0.0, 0.0));`,
  );
  insert(
    "    centerWeight += centerPairWeight;",
    `
    if (weightTraceEnabled) {
      weightTrace[sourceIndex * 8u + 3u].z = bitcast<u32>(centerPairWeight);
      weightTrace[sourceIndex * 8u + 3u].w = bitcast<u32>(centerWeight);
    }`,
  );
  insert(
    "    let shifted = bdptShiftReplay(bdptReservoirSample(source), uni.cam, sourcePixel, pixel, lightCount, &workspace);",
    `
    weightTraceFlag(sourceIndex, 4u);
    weightTraceF(sourceIndex, 4u, vec4f(shifted.evaluation.candidate.estimator, shifted.jacobian));`,
  );
  insert(
    "      source.path.contributionWeight, weight, shifted.jacobian, random);",
    `
    weightTraceFlag(sourceIndex, 8u);
    weightTraceF(sourceIndex, 5u, vec4f(own, weight, random, output.path.weightSum));
    weightTraceU(sourceIndex, 6u, output.path.sample.techniqueSeeds);
    weightTraceF(sourceIndex, 7u, vec4f(bdptTarget(shiftedSample), output.path.targetDensity, output.path.contributionWeight, confidence));`,
  );
  insert(
    "  bdptFinalizeReservoir(&output.path);",
    `
  weightTraceF(0u, 4u, vec4f(centerWeight, output.path.weightSum, output.path.contributionWeight, output.path.targetDensity));
  weightTraceU(0u, 5u, output.path.sample.techniqueSeeds);
  weightTraceU(0u, 6u, vec4u(selectionState, gRngState, u32(selectedCenter), 1u));`,
  );
  return (
    `
@group(1) @binding(2) var<storage, read_write> weightTrace: array<vec4u>;
var<private> weightTraceEnabled: bool;
fn weightTraceU(row: u32, slot: u32, value: vec4u) {
  if (weightTraceEnabled) { weightTrace[row * 8u + slot] = value; }
}
fn weightTraceF(row: u32, slot: u32, value: vec4f) {
  weightTraceU(row, slot, bitcast<vec4u>(value));
}
fn weightTraceFlag(row: u32, flag: u32) {
  if (weightTraceEnabled) { weightTrace[row * 8u].z |= flag; }
}
fn weightTraceNeighbor(row: u32, pixel: vec2u, rng: u32) {
  if (weightTraceEnabled) {
    weightTrace[row * 8u] = vec4u(pixel, weightTrace[row * 8u].z | 1u, rng);
  }
}
` + source
  );
};
