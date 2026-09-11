struct BdptScatter {
  direction: vec3f,
  throughput: vec3f,
  forwardPdf: f32,
  reversePdf: f32,
  delta: bool,
}

fn bdptRandom() -> f32 {
  return f32(pcgNext() >> 8u) * (1.0 / 16777216.0);
}

fn bdptSampleScatter(hit: HitInfo, incoming: vec3f, radianceTransport: bool, random: vec3f) -> BdptScatter {
  var scatter: BdptScatter;
  let cosIncident = clamp(dot(-incoming, hit.normal), 0.0, 1.0);
  if (cosIncident <= 0.0) {
    return scatter;
  }
  if (hit.materialIndex == 0u) {
    scatter.direction = cosineSampleHemisphere(hit.normal, random.x, random.y);
    scatter.throughput = hit.albedo;
    scatter.forwardPdf = max(0.0, dot(scatter.direction, hit.normal)) * INV_PI;
    scatter.reversePdf = cosIncident * INV_PI;
    return scatter;
  }
  scatter.delta = true;
  let ior = glassShapes[hit.materialIndex - 1u].tintIor.w;
  let eta = select(ior, 1.0 / ior, hit.frontFace);
  let reflectance = fresnelReflectance(cosIncident, eta);
  if (random.z < reflectance || reflectance >= 1.0) {
    scatter.direction = reflect(incoming, hit.normal);
    scatter.throughput = vec3f(1.0);
    scatter.forwardPdf = reflectance;
    scatter.reversePdf = reflectance;
  } else {
    scatter.direction = refract(incoming, hit.normal, eta);
    scatter.throughput = vec3f(select(1.0, eta * eta, radianceTransport));
    // Reverse transport crosses the tint boundary on entry rather than exit.
    if (hit.frontFace != radianceTransport) {
      scatter.throughput *= hit.albedo;
    }
    scatter.forwardPdf = 1.0 - reflectance;
    scatter.reversePdf = 1.0 - reflectance;
  }
  return scatter;
}

fn bdptPdfToArea(pdfSolidAngle: f32, source: vec3f, destination: vec3f, destinationNormal: vec3f) -> f32 {
  let displacement = source - destination;
  let distanceSquared = dot(displacement, displacement);
  if (distanceSquared <= 0.0) {
    return 0.0;
  }
  let cosine = abs(dot(destinationNormal, displacement * inverseSqrt(distanceSquared)));
  return pdfSolidAngle * cosine / distanceSquared;
}
