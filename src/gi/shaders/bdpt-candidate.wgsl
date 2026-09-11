struct BdptCandidate {
  estimator: vec3f,
  misWeight: f32,
  pixel: vec2u,
}

fn bdptVertexLimit() -> u32 {
  return min(BDPT_MAX_VERTICES, uni.maxBounces + 3u + max(4u, uni.glassShapeCount * 4u));
}

fn bdptPathWithinBudget(path: ptr<function, BdptMisPath>) -> bool {
  if ((*path).count < 2u || (*path).count > bdptVertexLimit()) {
    return false;
  }
  var diffuse = 0u;
  for (var index = 1u; index + 1u < (*path).count; index++) {
    diffuse += select(1u, 0u, (*path).vertices[index].delta);
    if (diffuse > uni.maxBounces + 1u
      || (diffuse == uni.maxBounces + 1u && index + 2u < (*path).count)) {
      return false;
    }
  }
  return true;
}

fn bdptEvaluateCandidate(camera: Camera, cameraVertices: u32, lightVertices: u32, pixel: vec2u, lightSubpathCount: u32, workspace: ptr<function, BdptWorkspace>) -> BdptCandidate {
  let cameraPath = &(*workspace).cameraPath;
  let lightPath = &(*workspace).lightPath;
  let path = &(*workspace).misPath;
  var candidate: BdptCandidate;
  candidate.pixel = pixel;
  bdptBuildMisPath(camera, cameraVertices, lightVertices, workspace);
  if (!bdptPathWithinBudget(path)) {
    return candidate;
  }
  if ((uni.flags & FLAG_BDPT) != 0u && (*path).count > 2u) {
    let direct = (*path).count == 3u && !(*path).vertices[1].delta;
    if ((direct && (uni.flags & FLAG_DI_ENABLED) == 0u) || (!direct && (uni.flags & FLAG_GI_ENABLED) == 0u)) {
      return candidate;
    }
  }
  if (lightVertices == 0u) {
    let vertex = (*cameraPath).vertices[cameraVertices - 2u];
    candidate.estimator = vertex.throughput * vertex.surface.emission;
  } else if (cameraVertices == 1u) {
    let vertex = (*lightPath).vertices[lightVertices - 1u];
    let projected = bdptProjectToCamera(camera, vertex.surface.pos, vertex.surface.normal);
    if (!projected.valid) {
      return candidate;
    }
    candidate.pixel = projected.pixel;
    candidate.estimator = bdptConnectCamera(camera, vertex, lightVertices == 1u);
  } else {
    candidate.estimator = bdptConnectSurfaces((*cameraPath).vertices[cameraVertices - 2u], (*lightPath).vertices[lightVertices - 1u], lightVertices == 1u);
  }
  if (maxComponent(candidate.estimator) > 0.0) {
    candidate.misWeight = bdptTechniqueWeight(camera, path, cameraVertices, lightSubpathCount);
  }
  return candidate;
}
