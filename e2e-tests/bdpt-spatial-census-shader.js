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
export const CENSUS_SHIFT_BASE =
  CENSUS_PHASES.length * CENSUS_REPLAY_FIELDS.length;
export const CENSUS_ACCEPTED_INDEX =
  CENSUS_SHIFT_BASE + CENSUS_SHIFT_FIELDS.length;
export const CENSUS_WORDS = CENSUS_ACCEPTED_INDEX + 1;
export const CENSUS_STRIDE_BYTES = CENSUS_WORDS * 4;

const fieldIndex = (fields, name) => {
  const index = fields.indexOf(name);
  if (index < 0) throw Error(`Unknown census field: ${name}`);
  return index;
};
const replayField = (name) => fieldIndex(CENSUS_REPLAY_FIELDS, name);
const shiftField = (name) =>
  CENSUS_SHIFT_BASE + fieldIndex(CENSUS_SHIFT_FIELDS, name);

const uniqueMarker = (code, marker) => {
  if (code.split(marker).length !== 2)
    throw Error(`Census marker missing or repeated: ${marker}`);
  return marker;
};

export const censusSpatialShader = (code) => {
  const replayDefinition = uniqueMarker(code, "fn bdptReplayPath(");
  const entry = uniqueMarker(code, "  let center = temporalReservoirs[index];");
  const inverse = uniqueMarker(
    code,
    "      let inverse = bdptApplyShift(preparedCenter, uni.cam, uni.cam, pixel, sourcePixel, lightCount, &workspace);",
  );
  const forward = uniqueMarker(
    code,
    "    let shifted = bdptShiftReplay(bdptReservoirSample(source), uni.cam, sourcePixel, pixel, lightCount, &workspace);",
  );
  const rejection = uniqueMarker(
    code,
    "    if (shifted.jacobian <= 0.0) { continue; }",
  );
  const selection = uniqueMarker(code, "  var selectionState = gRngState;");
  const exit = uniqueMarker(
    code,
    "  finalReservoirs[index] = BdptReservoirPair(output, center.caustic);\n}",
  );
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
  profileCounts[base + ${replayField("calls")}u] += 1u;
  if (reuseLightSubpath) {
    profileCounts[base + ${replayField("lightReuses")}u] += 1u;
  } else {
    profileCounts[base + ${replayField("lightBuilds")}u] += 1u;
    profileCounts[base + ${replayField("lightVertices")}u] += (*workspace).lightPath.count;
  }
  if (sample.techniqueSeeds.y > 1u) {
    profileCounts[base + ${replayField("cameraSide")}u] += 1u;
    if (sample.cameraReconnection.w > 0.0) { profileCounts[base + ${replayField("reconnecting")}u] += 1u; }
  }
  profileCounts[base + ${replayField("cameraVertices")}u] += (*workspace).cameraPath.count;
  if (maxComponent(evaluation.candidate.estimator) > 0.0) { profileCounts[base + ${replayField("productive")}u] += 1u; }
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
        `  profileCounts[${CENSUS_ACCEPTED_INDEX}u] = count - 1u;\n${selection}`,
      )
      .replace(
        inverse,
        `      profilePhase = ${phaseIndex.inverse}u;
${inverse}
      profileCounts[${shiftField("inverseShifts")}u] += 1u;
      if (inverse.jacobian <= 0.0) { profileCounts[${shiftField("inverseRejected")}u] += 1u; }`,
      )
      .replace(
        forward,
        `    profilePhase = ${phaseIndex.forward}u;
${forward}
    profileCounts[${shiftField("forwardShifts")}u] += 1u;`,
      )
      .replace(
        rejection,
        `    if (shifted.jacobian <= 0.0) { profileCounts[${shiftField("forwardRejected")}u] += 1u; continue; }`,
      )
      .replace(
        exit,
        `  finalReservoirs[index] = BdptReservoirPair(output, center.caustic);
  profileCensus[index].counts = profileCounts;
}`,
      )
  );
};
