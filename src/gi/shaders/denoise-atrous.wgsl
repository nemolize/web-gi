// 16x16 tile plus the stride-4 halo, cooperatively staged once per workgroup.

const ATROUS_WORKGROUP_SIZE: u32 = 16u;
const TILE_WIDTH: u32 = 32u;
const TILE_HALO: i32 = 8;
const TILE_TEXELS: u32 = TILE_WIDTH * TILE_WIDTH;

// 24 KiB total. Normals are already rgba16float, so packing them is lossless.
// Colour stays f32 because the first iteration reads rgba32float history.
var<workgroup> tileDepth: array<f32, TILE_TEXELS>;
var<workgroup> tileNormal: array<vec2u, TILE_TEXELS>;
var<workgroup> tileColorR: array<f32, TILE_TEXELS>;
var<workgroup> tileColorG: array<f32, TILE_TEXELS>;
var<workgroup> tileColorB: array<f32, TILE_TEXELS>;

fn prepareAtrousTile(localIndex: u32, workgroup: vec3u) {
  let tileOrigin = vec2i(workgroup.xy * ATROUS_WORKGROUP_SIZE) - vec2i(TILE_HALO);
  let workgroupTexels = ATROUS_WORKGROUP_SIZE * ATROUS_WORKGROUP_SIZE;
  for (var tileIndex = localIndex; tileIndex < TILE_TEXELS; tileIndex += workgroupTexels) {
    let tileOffset = vec2i(i32(tileIndex % TILE_WIDTH), i32(tileIndex / TILE_WIDTH));
    let source = tileOrigin + tileOffset;
    if (source.x >= 0 && source.y >= 0
      && source.x < i32(uni.resolution.x) && source.y < i32(uni.resolution.y)) {
      let sourcePixel = vec2u(source);
      let depth = textureLoad(texDepth, sourcePixel, 0).x;
      let normal = textureLoad(texNormal, sourcePixel, 0);
      let color = textureLoad(texColor, sourcePixel, 0).xyz;
      tileDepth[tileIndex] = depth;
      tileNormal[tileIndex] = vec2u(
        pack2x16float(normal.xy),
        pack2x16float(normal.zw),
      );
      tileColorR[tileIndex] = color.r;
      tileColorG[tileIndex] = color.g;
      tileColorB[tileIndex] = color.b;
    } else {
      tileDepth[tileIndex] = 0.0;
      tileNormal[tileIndex] = vec2u(0u);
      tileColorR[tileIndex] = 0.0;
      tileColorG[tileIndex] = 0.0;
      tileColorB[tileIndex] = 0.0;
    }
  }
  workgroupBarrier();
}

fn atrousCenterTile(lid: vec3u) -> vec2u {
  return lid.xy + vec2u(u32(TILE_HALO));
}

fn atrousTileIndex(tileCoord: vec2i) -> u32 {
  return u32(tileCoord.y) * TILE_WIDTH + u32(tileCoord.x);
}

fn atrousDepth(_pixel: vec2u, tileCoord: vec2i) -> f32 {
  return tileDepth[atrousTileIndex(tileCoord)];
}

fn atrousNormal(_pixel: vec2u, tileCoord: vec2i) -> vec3f {
  let packed = tileNormal[atrousTileIndex(tileCoord)];
  return vec4f(
    unpack2x16float(packed.x),
    unpack2x16float(packed.y),
  ).xyz;
}

fn atrousColor(_pixel: vec2u, tileCoord: vec2i) -> vec3f {
  let index = atrousTileIndex(tileCoord);
  return vec3f(tileColorR[index], tileColorG[index], tileColorB[index]);
}
