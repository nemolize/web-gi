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

fn bdptExtendSubpath(path: ptr<function, BdptSubpath>, first: HitInfo, incoming: vec3f, throughput: vec3f, radianceTransport: bool, maximumVertices: u32) {
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
    (*path).vertices[index].surface = hit;
    (*path).vertices[index].incoming = direction;
    (*path).vertices[index].throughput = beta;
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
    hit = traceScene(hit.pos + direction * SURFACE_EPS, direction);
  }
}

fn bdptCameraSubpath(camera: Camera, ndc: vec2f, seed: u32, maximumSurfaces: u32) -> BdptSubpath {
  gRngState = seed;
  var path: BdptSubpath;
  let direction = primaryRayDir(camera, ndc);
  let first = traceScenePrimary(camera.pos.xyz, direction);
  bdptExtendSubpath(&path, first, direction, vec3f(1.0), true, maximumSurfaces);
  return path;
}

fn bdptLightSubpath(seed: u32, maximumVertices: u32) -> BdptSubpath {
  gRngState = seed;
  var path: BdptSubpath;
  if (uni.lightCount == 0u || maximumVertices == 0u) {
    return path;
  }
  let light = sampleLight(bdptRandom(), bdptRandom(), bdptRandom());
  if (light.pdfArea <= 0.0) {
    return path;
  }
  var emitter: HitInfo;
  emitter.hit = true;
  emitter.pos = light.pos;
  emitter.normal = light.normal;
  emitter.emission = light.emission;
  emitter.quadIndex = light.quadIndex;
  emitter.frontFace = true;
  path.count = 1u;
  path.emitterPdfArea = light.pdfArea;
  path.vertices[0].surface = emitter;
  path.vertices[0].throughput = light.emission / light.pdfArea;
  let direction = cosineSampleHemisphere(light.normal, bdptRandom(), bdptRandom());
  let directionPdf = max(0.0, dot(light.normal, direction)) * INV_PI;
  path.vertices[0].sampledForwardPdf = directionPdf;
  if (directionPdf <= 0.0 || maximumVertices == 1u) {
    return path;
  }
  let first = traceScene(light.pos + direction * SURFACE_EPS, direction);
  bdptExtendSubpath(&path, first, direction, light.emission * PI / light.pdfArea, false, maximumVertices);
  return path;
}

fn bdptConnectSurfaces(cameraVertex: BdptVertex, lightVertex: BdptVertex, lightIsEmitter: bool) -> vec3f {
  let cameraHit = cameraVertex.surface;
  let lightHit = lightVertex.surface;
  if (cameraHit.materialIndex > 0u || lightHit.materialIndex > 0u) {
    return vec3f(0.0);
  }
  let difference = lightHit.pos - cameraHit.pos;
  let distanceSquared = dot(difference, difference);
  if (distanceSquared <= 0.0) {
    return vec3f(0.0);
  }
  let direction = difference * inverseSqrt(distanceSquared);
  let geometry = max(0.0, dot(cameraHit.normal, direction))
    * max(0.0, dot(lightHit.normal, -direction)) / distanceSquared;
  if (geometry <= 0.0 || !mutuallyVisible(cameraHit.pos, cameraHit.normal, lightHit.pos)) {
    return vec3f(0.0);
  }
  let lightBsdf = select(lightHit.albedo * INV_PI, vec3f(1.0), lightIsEmitter);
  return cameraVertex.throughput * cameraHit.albedo * INV_PI
    * lightVertex.throughput * lightBsdf * geometry;
}
