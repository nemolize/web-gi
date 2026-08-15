// Writes the linear radiance the present pass would tone map, so it can be
// read back and compared against the reference path tracer. Tone mapping and
// the sRGB encode are deliberately excluded: ACES compresses exactly the
// highlights an error metric needs to see, and 8-bit output quantises the rest.

@group(1) @binding(0) var texColor: texture_2d<f32>;
@group(1) @binding(1) var texAlbedo: texture_2d<f32>;
@group(1) @binding(2) var texEmission: texture_2d<f32>;
@group(1) @binding(3) var outLinear: texture_storage_2d<rgba32float, write>;

fn glassDiagnostic(ro: vec3f, rd: vec3f) -> f32 {
  let entry = traceScenePrimary(ro, rd);
  if (!entry.hit || entry.materialIndex == 0u) {
    return 0.0;
  }
  let shape = glassShapes[entry.materialIndex - 1u];
  let entryEta = select(shape.tintIor.w, 1.0 / shape.tintIor.w, entry.frontFace);
  let insideDirection = glassScatterDirection(rd, entry.normal, entryEta, false);
  if (dot(insideDirection, insideDirection) == 0.0) {
    return 1.0;
  }
  let exit = traceScene(entry.pos + insideDirection * SURFACE_EPS, insideDirection);
  if (!exit.hit || exit.materialIndex != entry.materialIndex || exit.frontFace) {
    return 1.0;
  }
  let outsideDirection = glassScatterDirection(
    insideDirection,
    exit.normal,
    shape.tintIor.w,
    false,
  );
  if (dot(outsideDirection, outsideDirection) == 0.0) {
    return 1.0;
  }
  let backdrop = traceScene(exit.pos + outsideDirection * SURFACE_EPS, outsideDirection);
  let transmittedCode = 2.0 + shape.centerKind.w;
  return select(1.0, transmittedCode, backdrop.hit && backdrop.materialIndex == 0u);
}

/** Mirrors the demodulated present path, minus `display`. */
@compute @workgroup_size(8, 8)
fn denoised(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  let illumination = textureLoad(texColor, pixel, 0).xyz;
  let packedAlbedo = textureLoad(texAlbedo, pixel, 0);
  let emission = textureLoad(texEmission, pixel, 0).xyz;
  let primaryDirection = primaryRayDir(uni.cam, pixelNdc(pixel));
  textureStore(
    outLinear,
    pixel,
    vec4f(
      illumination * packedAlbedo.xyz + emission,
      glassDiagnostic(uni.cam.pos.xyz, primaryDirection),
    ),
  );
}

/** Mirrors `fsReference` and derives its diagnostic mask independently. */
@compute @workgroup_size(8, 8)
fn reference(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.xy;
  if (pixel.x >= uni.resolution.x || pixel.y >= uni.resolution.y) {
    return;
  }
  let primaryDirection = primaryRayDir(uni.cam, pixelNdc(pixel));
  let diagnosticMask = glassDiagnostic(uni.cam.pos.xyz, primaryDirection);
  textureStore(outLinear, pixel, vec4f(textureLoad(texColor, pixel, 0).xyz, diagnosticMask));
}
