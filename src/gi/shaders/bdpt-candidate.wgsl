struct BdptCandidate {
  estimator: vec3f,
  misWeight: f32,
  pixel: vec2u,
}

fn bdptEvaluateCandidate(camera: Camera, cameraVertices: u32, lightVertices: u32, pixel: vec2u, lightSubpathCount: u32, workspace: ptr<function, BdptWorkspace>) -> BdptCandidate {
  let cameraPath = &(*workspace).cameraPath;
  let lightPath = &(*workspace).lightPath;
  let path = &(*workspace).misPath;
  var candidate: BdptCandidate;
  candidate.pixel = pixel;
  bdptBuildMisPath(camera, cameraVertices, lightVertices, workspace);
  if ((*path).count == 0u) {
    return candidate;
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
