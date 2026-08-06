// 8x8 tile geometry that fits WebGPU's baseline 16 KiB storage limit.

const ATROUS_WORKGROUP_SIZE: u32 = 8u;
const TILE_WIDTH: u32 = 24u;
const TILE_HALO: i32 = 8;
const TILE_TEXELS: u32 = TILE_WIDTH * TILE_WIDTH;
