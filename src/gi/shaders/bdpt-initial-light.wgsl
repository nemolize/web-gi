@group(1) @binding(0) var<storage, read_write> lightHeads: array<atomic<u32>>;
@group(1) @binding(1) var<storage, read_write> lightNodes: array<BdptLightNode>;

fn bdptPublishLight(reservoir: BdptReplayReservoir, pixel: vec2u, nodeIndex: u32, caustic: u32) {
  if (reservoir.path.targetDensity <= 0.0) { return; }
  let pixelIndex = pixel.y * uni.resolution.x + pixel.x;
  let previous = atomicExchange(&lightHeads[pixelIndex * 2u + caustic], nodeIndex + 1u);
  lightNodes[nodeIndex] = BdptLightNode(reservoir, vec4u(previous, pixel, 0u));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (any(pixel >= uni.resolution)) { return; }
  let index = pixel.y * uni.resolution.x + pixel.x;
  rngInit(pixel, uni.frame, 37u);
  let lightSeed = pcgNext();
  let selectionSeed = pcgNext();
  var workspace: BdptWorkspace;
  bdptBuildLightSubpath(lightSeed, bdptVertexLimit() - 1u, &workspace.lightPath);
  gRngState = selectionSeed;
  var normal = bdptEmptyReplayReservoir(1.0);
  var caustic = bdptEmptyReplayReservoir(1.0);
  var normalPixel = vec2u(0u);
  var causticPixel = vec2u(0u);
  for (var s = 1u; s <= workspace.lightPath.count; s++) {
    let candidate = bdptEvaluateCandidate(uni.cam, 1u, s, pixel, uni.resolution.x * uni.resolution.y, &workspace);
    let seeds = vec4u(s, 1u, 0u, lightSeed);
    var isCaustic = false;
    if (s > 1u) { isCaustic = workspace.lightPath.vertices[s - 2u].surface.materialIndex > 0u; }
    if (isCaustic) {
      if (bdptStreamInitial(&caustic, seeds, candidate)) { causticPixel = candidate.pixel; }
    } else {
      if (bdptStreamInitial(&normal, seeds, candidate)) { normalPixel = candidate.pixel; }
    }
  }
  bdptFinalizeReservoir(&normal.path);
  bdptFinalizeReservoir(&caustic.path);
  bdptPublishLight(normal, normalPixel, index * 2u, 0u);
  bdptPublishLight(caustic, causticPixel, index * 2u + 1u, 1u);
}
