struct BdptMisVertex {
  position: vec3f,
  normal: vec3f,
  delta: bool,
}

struct BdptMisPath {
  vertices: array<BdptMisVertex, BDPT_MAX_VERTICES>,
  count: u32,
  emitterPdfArea: f32,
}

struct BdptWorkspace {
  cameraPath: BdptSubpath,
  lightPath: BdptSubpath,
  misPath: BdptMisPath,
}

fn bdptEmitterPdfArea(quadIndex: u32) -> f32 {
  for (var index = 0u; index < uni.lightCount; index++) {
    if (lights[index].quadIndex == quadIndex) {
      return lights[index].selectPdf / quads[quadIndex].origin.w;
    }
  }
  return 0.0;
}

fn bdptMisVertexFromSurface(surface: HitInfo) -> BdptMisVertex {
  return BdptMisVertex(surface.pos, surface.normal, surface.materialIndex > 0u);
}

fn bdptBuildMisPath(camera: Camera, cameraVertices: u32, lightVertices: u32, workspace: ptr<function, BdptWorkspace>) {
  let cameraPath = &(*workspace).cameraPath;
  let lightPath = &(*workspace).lightPath;
  let path = &(*workspace).misPath;
  (*path).count = 0u;
  (*path).emitterPdfArea = 0.0;
  let count = cameraVertices + lightVertices;
  if (cameraVertices < 1u || count < 2u || count > BDPT_MAX_VERTICES
    || cameraVertices - 1u > (*cameraPath).count || lightVertices > (*lightPath).count) {
    return;
  }
  (*path).count = count;
  (*path).vertices[0] = BdptMisVertex(camera.pos.xyz, camera.forward.xyz, false);
  for (var index = 1u; index < cameraVertices; index++) {
    (*path).vertices[index] = bdptMisVertexFromSurface((*cameraPath).vertices[index - 1u].surface);
  }
  for (var index = 0u; index < lightVertices; index++) {
    (*path).vertices[cameraVertices + index] = bdptMisVertexFromSurface((*lightPath).vertices[lightVertices - index - 1u].surface);
  }
  if (lightVertices > 0u) {
    (*path).emitterPdfArea = (*lightPath).emitterPdfArea;
  } else {
    let emitter = (*cameraPath).vertices[cameraVertices - 2u].surface;
    if (emitter.materialIndex > 0u || maxComponent(emitter.emission) <= 0.0 || !emitter.frontFace) {
      (*path).count = 0u;
      return;
    }
    (*path).emitterPdfArea = bdptEmitterPdfArea(emitter.quadIndex);
    (*path).vertices[count - 1u].normal = quads[emitter.quadIndex].normal.xyz;
  }
}

fn bdptMisEdgeFactor(camera: Camera, path: ptr<function, BdptMisPath>, source: u32, destination: u32) -> f32 {
  let sourceVertex = (*path).vertices[source];
  let destinationVertex = (*path).vertices[destination];
  if (sourceVertex.delta) {
    return 1.0;
  }
  let difference = destinationVertex.position - sourceVertex.position;
  if (dot(difference, difference) <= 0.0) {
    return 0.0;
  }
  let direction = normalize(difference);
  var pdfW = max(0.0, dot(sourceVertex.normal, direction)) * INV_PI;
  if (source == 0u) {
    pdfW = bdptCameraPdfW(camera, direction) * f32(uni.resolution.x * uni.resolution.y);
  }
  return bdptPdfToArea(pdfW, sourceVertex.position, destinationVertex.position, destinationVertex.normal);
}

fn bdptTechniqueWeight(camera: Camera, path: ptr<function, BdptMisPath>, selectedCameraVertices: u32, lightSubpathCount: u32) -> f32 {
  let count = (*path).count;
  if (count < 2u || selectedCameraVertices < 1u || selectedCameraVertices > count) {
    return 0.0;
  }
  var forward: array<f32, BDPT_MAX_VERTICES>;
  var reverse: array<f32, BDPT_MAX_VERTICES>;
  var forwardZeros: array<u32, BDPT_MAX_VERTICES>;
  var reverseZeros: array<u32, BDPT_MAX_VERTICES>;
  for (var index = 1u; index < count; index++) {
    let factor = bdptMisEdgeFactor(camera, path, index - 1u, index);
    forward[index] = forward[index - 1u] + log(max(factor, 1e-38));
    forwardZeros[index] = forwardZeros[index - 1u] + select(1u, 0u, factor > 0.0);
  }
  reverse[count - 1u] = log(max((*path).emitterPdfArea, 1e-38));
  reverseZeros[count - 1u] = select(1u, 0u, (*path).emitterPdfArea > 0.0);
  for (var end = count - 1u; end > 1u; end--) {
    let index = end - 1u;
    let factor = bdptMisEdgeFactor(camera, path, index + 1u, index);
    reverse[index] = reverse[index + 1u] + log(max(factor, 1e-38));
    reverseZeros[index] = reverseZeros[index + 1u] + select(1u, 0u, factor > 0.0);
  }
  var sum: BdptMisSum;
  var selectedScore = 0.0;
  var selectedCount = 0u;
  var selectedSupported = false;
  for (var t = 1u; t <= count; t++) {
    var score = forward[t - 1u];
    var supported = forwardZeros[t - 1u] == 0u;
    if (t < count) {
      score += reverse[t];
      supported = supported && reverseZeros[t] == 0u
        && !(*path).vertices[t - 1u].delta && !(*path).vertices[t].delta;
    }
    let samples = select(1u, lightSubpathCount, t == 1u);
    bdptAccumulateMis(&sum, score, samples, supported);
    if (t == selectedCameraVertices) {
      selectedScore = score;
      selectedCount = samples;
      selectedSupported = supported;
    }
  }
  return bdptMisWeight(sum, selectedScore, selectedCount, selectedSupported);
}
