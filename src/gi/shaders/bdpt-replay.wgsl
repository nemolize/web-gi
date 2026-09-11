struct BdptReplaySample {
  techniqueSeeds: vec4u,
  filmOffsetOverride: vec4f,
}

struct BdptReplayEvaluation {
  candidate: BdptCandidate,
  endpoint: HitInfo,
  predecessor: HitInfo,
  lightPdfArea: f32,
  cameraPdfArea: f32,
  film: vec2f,
  caustic: bool,
}

struct BdptShift {
  sample: BdptReplaySample,
  evaluation: BdptReplayEvaluation,
  jacobian: f32,
}

fn bdptFilmNdc(film: vec2f) -> vec2f {
  return film / vec2f(uni.resolution) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
}

fn bdptReplay(sample: BdptReplaySample, camera: Camera, pixel: vec2u, lightSubpathCount: u32, workspace: ptr<function, BdptWorkspace>) -> BdptReplayEvaluation {
  var evaluation: BdptReplayEvaluation;
  let s = sample.techniqueSeeds.x;
  let t = sample.techniqueSeeds.y;
  if (t < 1u || s + t < 2u || s + t > BDPT_MAX_VERTICES) {
    return evaluation;
  }
  let cameraPath = &(*workspace).cameraPath;
  let lightPath = &(*workspace).lightPath;
  (*cameraPath).count = 0u;
  bdptBuildLightSubpath(sample.techniqueSeeds.w, s, lightPath);
  if (t > 1u) {
    gRngState = sample.techniqueSeeds.z;
    let jitter = vec2f(bdptRandom(), bdptRandom());
    let pathSeed = gRngState;
    bdptBuildCameraSubpath(camera, bdptFilmNdc(vec2f(pixel) + jitter), pathSeed, t - 1u, cameraPath);
  } else if (sample.filmOffsetOverride.z > 0.0) {
    let ray = primaryRayDir(camera, bdptFilmNdc(vec2f(pixel) + sample.filmOffsetOverride.xy));
    let endpoint = traceScenePrimary(camera.pos.xyz, ray);
    if (!endpoint.hit || endpoint.materialIndex > 0u || (*lightPath).count < max(1u, s - 1u)) {
      return evaluation;
    }
    if (s == 1u) {
      if (endpoint.quadIndex != (*lightPath).vertices[0].surface.quadIndex || !endpoint.frontFace) {
        return evaluation;
      }
      (*lightPath).vertices[0].surface = endpoint;
    } else {
      let previous = (*lightPath).vertices[s - 2u];
      let difference = endpoint.pos - previous.surface.pos;
      if (previous.surface.materialIndex > 0u || dot(difference, difference) <= 0.0
        || dot(previous.surface.normal, difference) <= 0.0 || dot(endpoint.normal, -difference) <= 0.0
        || !mutuallyVisible(previous.surface.pos, previous.surface.normal, endpoint.pos)) {
        return evaluation;
      }
      var throughput = previous.throughput * previous.surface.albedo;
      if (s == 2u) {
        throughput = previous.throughput * PI;
      }
      (*lightPath).vertices[s - 1u] = BdptVertex(endpoint, normalize(difference), throughput, 0.0, 0.0, false);
      (*lightPath).count = s;
    }
  }
  evaluation.candidate = bdptEvaluateCandidate(camera, t, s, pixel, lightSubpathCount, workspace);
  if (maxComponent(evaluation.candidate.estimator) <= 0.0 || evaluation.candidate.misWeight <= 0.0) {
    return evaluation;
  }
  if (t == 1u) {
    evaluation.endpoint = (*lightPath).vertices[s - 1u].surface;
    let projection = bdptProjectToCamera(camera, evaluation.endpoint.pos, evaluation.endpoint.normal);
    evaluation.cameraPdfArea = projection.pdfArea;
    evaluation.film = projection.film;
    evaluation.lightPdfArea = (*lightPath).emitterPdfArea;
    if (s > 1u) {
      evaluation.predecessor = (*lightPath).vertices[s - 2u].surface;
      evaluation.caustic = evaluation.predecessor.materialIndex > 0u;
      evaluation.lightPdfArea = 0.0;
      if (!evaluation.caustic) {
        let direction = normalize(evaluation.endpoint.pos - evaluation.predecessor.pos);
        let pdfW = max(0.0, dot(evaluation.predecessor.normal, direction)) * INV_PI;
        evaluation.lightPdfArea = bdptPdfToArea(pdfW, evaluation.predecessor.pos, evaluation.endpoint.pos, evaluation.endpoint.normal);
      }
    }
  }
  return evaluation;
}

fn bdptShiftBetweenCameras(sample: BdptReplaySample, sourceCamera: Camera, destinationCamera: Camera, sourcePixel: vec2u, destinationPixel: vec2u, lightSubpathCount: u32, workspace: ptr<function, BdptWorkspace>) -> BdptShift {
  var shifted: BdptShift;
  shifted.sample = sample;
  if (sample.techniqueSeeds.y > 1u) {
    shifted.evaluation = bdptReplay(sample, destinationCamera, destinationPixel, lightSubpathCount, workspace);
    shifted.jacobian = 1.0;
    return shifted;
  }
  let source = bdptReplay(sample, sourceCamera, sourcePixel, lightSubpathCount, workspace);
  if (source.cameraPdfArea <= 0.0 || any(source.candidate.pixel != sourcePixel)) {
    return shifted;
  }
  if (all(sourcePixel == destinationPixel) && all(sourceCamera.pos == destinationCamera.pos)
    && all(sourceCamera.right == destinationCamera.right) && all(sourceCamera.up == destinationCamera.up)
    && all(sourceCamera.forward == destinationCamera.forward)) {
    shifted.evaluation = source;
    shifted.jacobian = 1.0;
    return shifted;
  }
  if (source.caustic || source.lightPdfArea <= 0.0) {
    return shifted;
  }
  shifted.sample.filmOffsetOverride = vec4f(fract(source.film), 1.0, 0.0);
  shifted.evaluation = bdptReplay(shifted.sample, destinationCamera, destinationPixel, lightSubpathCount, workspace);
  if (shifted.evaluation.cameraPdfArea > 0.0) {
    // The estimator includes proposal PDFs; convert the endpoint shift to primary-sample measure.
    shifted.jacobian = (shifted.evaluation.lightPdfArea / source.lightPdfArea)
      * (source.cameraPdfArea / shifted.evaluation.cameraPdfArea);
  }
  return shifted;
}

fn bdptShiftReplay(sample: BdptReplaySample, camera: Camera, sourcePixel: vec2u, destinationPixel: vec2u, lightSubpathCount: u32, workspace: ptr<function, BdptWorkspace>) -> BdptShift {
  return bdptShiftBetweenCameras(sample, camera, camera, sourcePixel, destinationPixel, lightSubpathCount, workspace);
}

fn bdptShiftCaustic(sample: BdptReplaySample, destinationCamera: Camera, lightSubpathCount: u32, workspace: ptr<function, BdptWorkspace>) -> BdptShift {
  var shifted: BdptShift;
  shifted.sample = sample;
  if (sample.techniqueSeeds.y != 1u || sample.filmOffsetOverride.z > 0.0) { return shifted; }
  shifted.evaluation = bdptReplay(sample, destinationCamera, vec2u(0u), lightSubpathCount, workspace);
  if (shifted.evaluation.caustic && shifted.evaluation.cameraPdfArea > 0.0) {
    shifted.jacobian = 1.0;
  }
  return shifted;
}
