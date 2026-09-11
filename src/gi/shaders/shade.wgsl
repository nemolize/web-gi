@group(1) @binding(0) var texDepth: texture_2d<f32>;
@group(1) @binding(1) var texNormal: texture_2d<f32>;
@group(1) @binding(2) var<storage, read> diReservoirs: array<DiReservoir>;
@group(1) @binding(3) var<storage, read> giReservoirs: array<GiReservoir>;
@group(1) @binding(4) var outIllumination: texture_storage_2d<rgba16float, write>;

fn unreusedGlassIllumination(x: vec3f, n: vec3f) -> vec3f {
  if (uni.glassShapeCount == 0u || (uni.flags & FLAG_GI_ENABLED) == 0u || (uni.flags & FLAG_PT_FALLBACK) == 0u) {
    return vec3f(0.0);
  }
  let dir = cosineSampleHemisphere(n, rand(), rand());
  let hit = traceScene(x + n * SURFACE_EPS, dir);
  if (!hit.hit || hit.materialIndex == 0u) {
    return vec3f(0.0);
  }
  // ReSTIR GI excludes this first-hit class; cosine sampling cancels the
  // demodulated Lambertian BRDF, so only the remaining path radiance is needed.
  return pathRadiance(
    hit.pos,
    hit.normal,
    hit.albedo,
    hit.materialIndex,
    hit.frontFace,
    dir,
    uni.maxBounces,
  );
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  let index = pixel.y * uni.resolution.x + pixel.x;

  let depth = textureLoad(texDepth, pixel, 0).x;
  if (!surfaceHit(depth)) {
    textureStore(outIllumination, pixel, vec4f(0.0));
    return;
  }
  let x = surfacePosition(uni.cam, pixel, depth);
  let packedNormal = textureLoad(texNormal, pixel, 0);
  let n = packedNormal.xyz;
  let materialIndex = u32(abs(packedNormal.w) + 0.5);

  if (materialIndex > 0u) {
    rngInit(pixel, uni.frame, 11u);
    let incoming = normalize(x - uni.cam.pos.xyz);
    let radiance = min(
      pathRadiance(
        x,
        n,
        materialAlbedo(materialIndex),
        materialIndex,
        packedNormal.w > 0.0,
        incoming,
        uni.maxBounces + 1u,
      ),
      vec3f(MAX_ILLUMINATION),
    );
    textureStore(outIllumination, pixel, vec4f(radiance, 1.0));
    return;
  }

  var illumination = vec3f(0.0);

  let di = diReservoirs[index];
  let diWeight = diReservoirWeight(di);
  if (diWeight > 0.0) {
    let contribution = directContribution(x, n, vec3f(1.0), di.lightPos.xyz, di.lightQuad);
    // Visibility is excluded from the RIS target function, so it is applied
    // exactly once here, on the surviving sample.
    if (maxComponent(contribution) > 0.0 && mutuallyVisible(x, n, di.lightPos.xyz)) {
      illumination += contribution * diWeight;
    }
  }

  let gi = giReservoirs[index];
  let giWeight = giReservoirWeight(gi);
  if (giWeight > 0.0) {
    illumination += giContribution(x, n, vec3f(1.0), gi) * giWeight;
  }

  rngInit(pixel, uni.frame, 12u);
  illumination += unreusedGlassIllumination(x, n);

  illumination = min(illumination, vec3f(MAX_ILLUMINATION));
  textureStore(outIllumination, pixel, vec4f(illumination, 1.0));
}
