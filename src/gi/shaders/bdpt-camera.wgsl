struct BdptCameraConnection {
  pixel: vec2u,
  film: vec2f,
  pdfArea: f32,
  valid: bool,
}

fn bdptCameraPdfW(camera: Camera, direction: vec3f) -> f32 {
  let cosine = dot(camera.forward.xyz, direction);
  if (cosine <= 0.0) {
    return 0.0;
  }
  let filmArea = 4.0 * camTanHalfFov(camera) * camTanHalfFov(camera) * camAspect(camera);
  return 1.0 / (filmArea * cosine * cosine * cosine);
}

fn bdptProjectToCamera(camera: Camera, position: vec3f, normal: vec3f) -> BdptCameraConnection {
  var connection: BdptCameraConnection;
  let displacement = position - camera.pos.xyz;
  let depth = dot(camera.forward.xyz, displacement);
  if (depth <= 0.0) {
    return connection;
  }
  let ndc = vec2f(dot(camera.right.xyz, displacement) / camAspect(camera), dot(camera.up.xyz, displacement))
    / (depth * camTanHalfFov(camera));
  let uv = ndc * vec2f(0.5, -0.5) + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) {
    return connection;
  }
  let direction = normalize(displacement);
  if (dot(normal, -direction) <= 0.0) {
    return connection;
  }
  connection.film = uv * vec2f(uni.resolution);
  connection.pixel = vec2u(connection.film);
  connection.pdfArea = bdptPdfToArea(bdptCameraPdfW(camera, direction), camera.pos.xyz, position, normal)
    * f32(uni.resolution.x * uni.resolution.y);
  connection.valid = connection.pdfArea > 0.0;
  return connection;
}

fn bdptCameraVisible(camera: Camera, position: vec3f) -> bool {
  let displacement = position - camera.pos.xyz;
  let distance = length(displacement);
  if (distance <= SURFACE_EPS) {
    return false;
  }
  let hit = traceScenePrimary(camera.pos.xyz, displacement / distance);
  return hit.hit && abs(hit.t - distance) <= 2.0 * SURFACE_EPS;
}

fn bdptConnectCamera(camera: Camera, vertex: BdptVertex, lightIsEmitter: bool) -> vec3f {
  if (vertex.surface.materialIndex > 0u) {
    return vec3f(0.0);
  }
  let connection = bdptProjectToCamera(camera, vertex.surface.pos, vertex.surface.normal);
  if (!connection.valid || !bdptCameraVisible(camera, vertex.surface.pos)) {
    return vec3f(0.0);
  }
  let bsdf = select(vertex.surface.albedo * INV_PI, vec3f(1.0), lightIsEmitter);
  return vertex.throughput * bsdf * connection.pdfArea;
}
