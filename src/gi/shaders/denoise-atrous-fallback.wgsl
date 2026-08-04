// Texture-backed fallback for devices limited to WebGPU's baseline 16 KiB of
// workgroup storage. The shared entry point keeps its filter arithmetic exact.

const ATROUS_WORKGROUP_SIZE: u32 = 8u;

fn prepareAtrousTile(_localIndex: u32, _workgroup: vec3u) {}

fn atrousCenterTile(lid: vec3u) -> vec2u {
  return lid.xy;
}

fn atrousDepth(pixel: vec2u, _tileCoord: vec2i) -> f32 {
  return textureLoad(texDepth, pixel, 0).x;
}

fn atrousNormal(pixel: vec2u, _tileCoord: vec2i) -> vec3f {
  return textureLoad(texNormal, pixel, 0).xyz;
}

fn atrousColor(pixel: vec2u, _tileCoord: vec2i) -> vec3f {
  return textureLoad(texColor, pixel, 0).xyz;
}
