// Fullscreen resolve: remodulate albedo, tone map, encode to sRGB.
// The canvas backing store matches the render resolution, so the fragment's
// framebuffer coordinate indexes the source textures directly.

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(1) @binding(0) var texColor: texture_2d<f32>;
@group(1) @binding(1) var texAlbedo: texture_2d<f32>;
@group(1) @binding(2) var texEmission: texture_2d<f32>;
@group(1) @binding(3) var texSnapshot: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}

fn display(radiance: vec3f) -> vec4f {
  return vec4f(linearToSrgb(acesFilmic(radiance * uni.exposure)), 1.0);
}

fn transitionColor(pixel: vec2f) -> vec4f {
  let texel = pixel / vec2f(uni.resolution) * uni.transition.xy - vec2f(0.5);
  let base = vec2i(floor(texel));
  let fraction = fract(texel);
  let limit = vec2i(uni.transition.xy) - vec2i(1);
  let a = textureLoad(texSnapshot, clamp(base, vec2i(0), limit), 0);
  let b = textureLoad(texSnapshot, clamp(base + vec2i(1, 0), vec2i(0), limit), 0);
  let c = textureLoad(texSnapshot, clamp(base + vec2i(0, 1), vec2i(0), limit), 0);
  let d = textureLoad(texSnapshot, clamp(base + vec2i(1, 1), vec2i(0), limit), 0);
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}

@fragment
fn fsRestir(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let pixel = vec2u(coord.xy);
  let illumination = textureLoad(texColor, pixel, 0).xyz;
  let albedo = textureLoad(texAlbedo, pixel, 0).xyz;
  let emission = textureLoad(texEmission, pixel, 0).xyz;
  let color = display(select(illumination * albedo + emission, illumination, (uni.flags & FLAG_BDPT) != 0u));
  if (uni.transition.z > 0.0) {
    return mix(color, transitionColor(coord.xy), uni.transition.z);
  }
  return color;
}

@fragment
fn fsReference(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  return display(textureLoad(texColor, vec2u(coord.xy), 0).xyz);
}
