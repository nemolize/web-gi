override BDPT_WORKGROUP_SIZE: u32 = 8u;

const BDPT_MAX_VERTICES: u32 = 32u;

struct BdptVertex {
  surface: HitInfo,
  incoming: vec3f,
  throughput: vec3f,
  sampledForwardPdf: f32,
  sampledReversePdf: f32,
  sampledDelta: bool,
}

struct BdptSubpath {
  vertices: array<BdptVertex, BDPT_MAX_VERTICES>,
  count: u32,
  emitterPdfArea: f32,
}

fn bdptExtendSubpath(path: ptr<function, BdptSubpath>, first: HitInfo, incoming: vec3f, throughput: vec3f, radianceTransport: bool, maximumVertices: u32, reconnection: vec4f, surfaceCode: u32) {
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

fn bdptBuildCameraSubpath(camera: Camera, ndc: vec2f, seed: u32, maximumSurfaces: u32, path: ptr<function, BdptSubpath>) {
  gRngState = seed;
  (*path).count = 0u;
  (*path).emitterPdfArea = 0.0;
  let direction = primaryRayDir(camera, ndc);
  let first = traceScenePrimary(camera.pos.xyz, direction);
  bdptExtendSubpath(path, first, direction, vec3f(1.0), true, maximumSurfaces, vec4f(0.0), 0u);
}

fn bdptBuildLightSubpath(seed: u32, maximumVertices: u32, path: ptr<function, BdptSubpath>) {
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
  bdptExtendSubpath(path, first, direction, light.emission * PI / light.pdfArea, false, maximumVertices, vec4f(0.0), 0u);
}

fn bdptCameraSubpath(camera: Camera, ndc: vec2f, seed: u32, maximumSurfaces: u32) -> BdptSubpath {
  var path: BdptSubpath;
  bdptBuildCameraSubpath(camera, ndc, seed, maximumSurfaces, &path);
  return path;
}

fn bdptLightSubpath(seed: u32, maximumVertices: u32) -> BdptSubpath {
  var path: BdptSubpath;
  bdptBuildLightSubpath(seed, maximumVertices, &path);
  return path;
}

fn bdptConnectSurfaces(cameraVertex: ptr<function, BdptVertex>, lightVertex: ptr<function, BdptVertex>, lightIsEmitter: bool) -> vec3f {
  let cameraHit = &(*cameraVertex).surface;
  let lightHit = &(*lightVertex).surface;
  if ((*cameraHit).materialIndex > 0u || (*lightHit).materialIndex > 0u) {
    return vec3f(0.0);
  }
  let difference = (*lightHit).pos - (*cameraHit).pos;
  let distanceSquared = dot(difference, difference);
  if (distanceSquared <= 0.0) {
    return vec3f(0.0);
  }
  let direction = difference * inverseSqrt(distanceSquared);
  let geometry = max(0.0, dot((*cameraHit).normal, direction))
    * max(0.0, dot((*lightHit).normal, -direction)) / distanceSquared;
  if (geometry <= 0.0 || !mutuallyVisible((*cameraHit).pos, (*cameraHit).normal, (*lightHit).pos)) {
    return vec3f(0.0);
  }
  let lightBsdf = select((*lightHit).albedo * INV_PI, vec3f(1.0), lightIsEmitter);
  return (*cameraVertex).throughput * (*cameraHit).albedo * INV_PI
    * (*lightVertex).throughput * lightBsdf * geometry;
}

fn bdptBuildCameraReplay(camera: Camera, ndc: vec2f, seed: u32, maximumSurfaces: u32, reconnection: vec4f, surfaceCode: u32, path: ptr<function, BdptSubpath>) {
  gRngState = seed;
  (*path).count = 0u;
  (*path).emitterPdfArea = 0.0;
  let direction = primaryRayDir(camera, ndc);
  bdptExtendSubpath(path, traceScenePrimary(camera.pos.xyz, direction), direction, vec3f(1.0), true, maximumSurfaces, reconnection, surfaceCode);
}

fn bdptCameraReconnection(path: ptr<function, BdptSubpath>) -> u32 {
  for (var index = 1u; index < (*path).count; index++) {
    if ((*path).vertices[index - 1u].surface.materialIndex == 0u && (*path).vertices[index].surface.materialIndex == 0u) {
      return index + 1u;
    }
  }
  return 0u;
}

fn bdptCameraConnectionPdf(path: ptr<function, BdptSubpath>, reconnection: u32) -> f32 {
  if (reconnection < 2u || reconnection > (*path).count) { return 0.0; }
  let source = (*path).vertices[reconnection - 2u].surface;
  let destination = (*path).vertices[reconnection - 1u].surface;
  let difference = destination.pos - source.pos;
  if (length(difference) <= SURFACE_EPS) { return 0.0; }
  return bdptPdfToArea(max(0.0, dot(source.normal, normalize(difference))) * INV_PI, source.pos, destination.pos, destination.normal);
}
