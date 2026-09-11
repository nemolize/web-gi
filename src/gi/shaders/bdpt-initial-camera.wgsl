@group(1) @binding(0) var<storage, read_write> cameraReservoirs: array<BdptReplayReservoir>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (any(pixel >= uni.resolution)) { return; }
  rngInit(pixel, uni.frame, 31u);
  let cameraSeed = pcgNext();
  let lightSeed = pcgNext();
  let selectionSeed = pcgNext();
  var workspace: BdptWorkspace;
  let limit = bdptVertexLimit();
  gRngState = cameraSeed;
  let jitter = vec2f(bdptRandom(), bdptRandom());
  let pathSeed = gRngState;
  bdptBuildCameraSubpath(uni.cam, bdptFilmNdc(vec2f(pixel) + jitter), pathSeed, limit - 1u, &workspace.cameraPath);
  bdptBuildLightSubpath(lightSeed, limit - 2u, &workspace.lightPath);
  gRngState = selectionSeed;
  var reservoir = bdptEmptyReplayReservoir(1.0);
  for (var t = 2u; t <= workspace.cameraPath.count + 1u; t++) {
    for (var s = 0u; s <= workspace.lightPath.count && s + t <= limit; s++) {
      let candidate = bdptEvaluateCandidate(uni.cam, t, s, pixel, uni.resolution.x * uni.resolution.y, &workspace);
      bdptStreamInitial(&reservoir, vec4u(s, t, cameraSeed, lightSeed), candidate);
    }
  }
  bdptFinalizeReservoir(&reservoir.path);
  cameraReservoirs[pixel.y * uni.resolution.x + pixel.x] = reservoir;
}
