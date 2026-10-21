export const CENSUS_PHASES = ["forward", "inverse", "centerPrepare"];
export const CENSUS_REPLAY_FIELDS = [
  "calls",
  "lightBuilds",
  "lightReuses",
  "cameraSide",
  "cameraVertices",
  "lightVertices",
  "productive",
  "reconnecting",
];
export const CENSUS_SHIFT_FIELDS = [
  "forwardShifts",
  "forwardRejected",
  "inverseShifts",
  "inverseRejected",
];
const ACCEPTED_INDEX =
  CENSUS_PHASES.length * CENSUS_REPLAY_FIELDS.length +
  CENSUS_SHIFT_FIELDS.length;
export const CENSUS_WORDS = ACCEPTED_INDEX + 1;
export const CENSUS_STRIDE_BYTES = CENSUS_WORDS * 4;

const once = (code, marker) => {
  if (code.split(marker).length !== 2)
    throw Error(`Census marker missing or repeated: ${marker}`);
  return marker;
};

export const censusSpatialShader = (code) => {
  const replayDefinition = once(code, "fn bdptReplayPath(");
  const entry = once(code, "  let center = temporalReservoirs[index];");
  const inverse = once(
    code,
    "      let inverse = bdptApplyShift(preparedCenter, uni.cam, uni.cam, pixel, sourcePixel, lightCount, &workspace);",
  );
  const forward = once(
    code,
    "    let shifted = bdptShiftReplay(bdptReservoirSample(source), uni.cam, sourcePixel, pixel, lightCount, &workspace);",
  );
  const rejection = once(
    code,
    "    if (shifted.jacobian <= 0.0) { continue; }",
  );
  const selection = once(code, "  var selectionState = gRngState;");
  const exit = once(
    code,
    "  finalReservoirs[index] = BdptReservoirPair(output, center.caustic);\n}",
  );
  const shiftBase = CENSUS_PHASES.length * CENSUS_REPLAY_FIELDS.length;
  const phaseIndex = Object.fromEntries(
    CENSUS_PHASES.map((phase, index) => [phase, index]),
  );
  const storage = `
struct ProfileCensus {
  counts: array<u32, ${CENSUS_WORDS}>,
}
@group(3) @binding(0) var<storage, read_write> profileCensus: array<ProfileCensus>;
var<private> profileCounts: array<u32, ${CENSUS_WORDS}>;
var<private> profilePhase: u32 = ${phaseIndex.centerPrepare}u;

fn bdptReplayPath(sample: BdptReplaySample, camera: Camera, pixel: vec2u, lightSubpathCount: u32, workspace: ptr<function, BdptWorkspace>, reuseLightSubpath: bool) -> BdptReplayEvaluation {
  let evaluation = bdptReplayPathUncounted(sample, camera, pixel, lightSubpathCount, workspace, reuseLightSubpath);
  let base = profilePhase * ${CENSUS_REPLAY_FIELDS.length}u;
  profileCounts[base] += 1u;
  if (reuseLightSubpath) {
    profileCounts[base + 2u] += 1u;
  } else {
    profileCounts[base + 1u] += 1u;
    profileCounts[base + 5u] += (*workspace).lightPath.count;
  }
  if (sample.techniqueSeeds.y > 1u) {
    profileCounts[base + 3u] += 1u;
    if (sample.cameraReconnection.w > 0.0) { profileCounts[base + 7u] += 1u; }
  }
  profileCounts[base + 4u] += (*workspace).cameraPath.count;
  if (maxComponent(evaluation.candidate.estimator) > 0.0) { profileCounts[base + 6u] += 1u; }
  return evaluation;
}
`;
  return (
    storage +
    code
      .replace(replayDefinition, "fn bdptReplayPathUncounted(")
      .replace(
        entry,
        `${entry}\n  profileCensus[index].counts = profileCounts;`,
      )
      .replace(
        selection,
        `  profileCounts[${ACCEPTED_INDEX}u] = count - 1u;\n${selection}`,
      )
      .replace(
        inverse,
        `      profilePhase = ${phaseIndex.inverse}u;
${inverse}
      profileCounts[${shiftBase + 2}u] += 1u;
      if (inverse.jacobian <= 0.0) { profileCounts[${shiftBase + 3}u] += 1u; }`,
      )
      .replace(
        forward,
        `    profilePhase = ${phaseIndex.forward}u;
${forward}
    profileCounts[${shiftBase}u] += 1u;`,
      )
      .replace(
        rejection,
        `    if (shifted.jacobian <= 0.0) { profileCounts[${shiftBase + 1}u] += 1u; continue; }`,
      )
      .replace(
        exit,
        `  finalReservoirs[index] = BdptReservoirPair(output, center.caustic);
  profileCensus[index].counts = profileCounts;
}`,
      )
  );
};
