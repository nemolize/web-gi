fn bdptExtendSubpathUnbounded(path: ptr<function, BdptSubpath>, first: HitInfo, incoming: vec3f, throughput: vec3f, radianceTransport: bool, maximumVertices: u32, reconnection: vec4f, surfaceCode: u32) {
  var hit = first;
  var direction = incoming;
  var beta = throughput;
  let limit = min(maximumVertices, BDPT_MAX_VERTICES);
  loop {
    if (!hit.hit || (*path).count >= limit) {
      break;
    }
    let index = (*path).count;
    (*path).count += 1u;
    (*path).vertices[index] = BdptVertex(hit, direction, beta, 0.0, 0.0, false);
    if (maxComponent(hit.emission) > 0.0 || (*path).count >= limit) {
      break;
    }
    let random = vec3f(bdptRandom(), bdptRandom(), bdptRandom());
    let scatter = bdptSampleScatter(hit, direction, radianceTransport, random);
    (*path).vertices[index].sampledForwardPdf = scatter.forwardPdf;
    (*path).vertices[index].sampledReversePdf = scatter.reversePdf;
    (*path).vertices[index].sampledDelta = scatter.delta;
    if (scatter.forwardPdf <= 0.0 || maxComponent(scatter.throughput) <= 0.0) {
      break;
    }
    beta *= scatter.throughput;
    direction = scatter.direction;
    if (reconnection.w > 0.0 && index + 2u == u32(reconnection.w)) {
      let difference = reconnection.xyz - hit.pos;
      if (hit.materialIndex > 0u || length(difference) <= SURFACE_EPS || dot(hit.normal, difference) <= 0.0) {
        (*path).count = 0u;
        return;
      }
      direction = normalize(difference);
      var connected = traceScene(hit.pos + direction * SURFACE_EPS, direction);
      if (!connected.hit || connected.materialIndex > 0u || length(connected.pos - reconnection.xyz) > 2.0 * SURFACE_EPS
        || connected.quadIndex != surfaceCode / 2u || connected.frontFace != ((surfaceCode & 1u) == 1u)) {
        (*path).count = 0u;
        return;
      }
      (*path).vertices[index].sampledForwardPdf = dot(hit.normal, direction) * INV_PI;
      connected.pos = reconnection.xyz;
      hit = connected;
      continue;
    }
    hit = traceScene(hit.pos + direction * SURFACE_EPS, direction);
  }
}

fn bdptBuildCameraSubpathUnbounded(camera: Camera, ndc: vec2f, seed: u32, maximumSurfaces: u32, path: ptr<function, BdptSubpath>) {
  gRngState = seed;
  (*path).count = 0u;
  (*path).emitterPdfArea = 0.0;
  let direction = primaryRayDir(camera, ndc);
  let first = traceScenePrimary(camera.pos.xyz, direction);
  bdptExtendSubpathUnbounded(path, first, direction, vec3f(1.0), true, maximumSurfaces, vec4f(0.0), 0u);
}

fn bdptBuildLightSubpathUnbounded(seed: u32, maximumVertices: u32, path: ptr<function, BdptSubpath>) {
  gRngState = seed;
  (*path).count = 0u;
  (*path).emitterPdfArea = 0.0;
  if (uni.lightCount == 0u || maximumVertices == 0u) {
    return;
  }
  let light = sampleLight(bdptRandom(), bdptRandom(), bdptRandom());
  if (light.pdfArea <= 0.0) {
    return;
  }
  var emitter: HitInfo;
  emitter.hit = true;
  emitter.pos = light.pos;
  emitter.normal = light.normal;
  emitter.emission = light.emission;
  emitter.quadIndex = light.quadIndex;
  emitter.frontFace = true;
  (*path).count = 1u;
  (*path).emitterPdfArea = light.pdfArea;
  (*path).vertices[0] = BdptVertex(emitter, vec3f(0.0), light.emission / light.pdfArea, 0.0, 0.0, false);
  let direction = cosineSampleHemisphere(light.normal, bdptRandom(), bdptRandom());
  let directionPdf = max(0.0, dot(light.normal, direction)) * INV_PI;
  (*path).vertices[0].sampledForwardPdf = directionPdf;
  if (directionPdf <= 0.0 || maximumVertices == 1u) {
    return;
  }
  let first = traceScene(light.pos + direction * SURFACE_EPS, direction);
  bdptExtendSubpathUnbounded(path, first, direction, light.emission * PI / light.pdfArea, false, maximumVertices, vec4f(0.0), 0u);
}
