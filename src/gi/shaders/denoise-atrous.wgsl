// 16x16 tile geometry for devices that expose 24 KiB of workgroup storage.

const ATROUS_WORKGROUP_SIZE: u32 = 16u;
const TILE_WIDTH: u32 = 32u;
const TILE_HALO: i32 = 8;
const TILE_TEXELS: u32 = TILE_WIDTH * TILE_WIDTH;
