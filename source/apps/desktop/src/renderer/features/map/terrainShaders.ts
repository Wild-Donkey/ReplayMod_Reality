import { LAND_MIN_LINEAR, OCEAN_MAX_LINEAR, TERRAIN_EXPOSURE_STOPS } from "./terrainExposure";
// No normalized colour texture or precoloured tile exists in the terrain path.
export const elevationShader = `
struct Tile { matrix: mat4x4f, bounds: vec4f, size: vec4f }
@group(0) @binding(0) var height: texture_2d<f32>;
@group(0) @binding(1) var<uniform> tile: Tile;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
  let corners = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let uv = corners[i];
  let clip = tile.matrix * vec4f(tile.bounds.xy + uv * tile.bounds.zw, 0, 1);
  // WebGL and WebGPU have different depth ranges; terrain is a flat 2D pass.
  return Vertex(vec4f(clip.xy, 0, clip.w), uv);
}
@fragment fn fragment(v: Vertex) -> @location(0) vec2f {
  let dimensions = vec2i(textureDimensions(height));
  let pixel = v.uv * vec2f(dimensions) - 0.5;
  let base = vec2i(floor(pixel)); let f = fract(pixel);
  // Interpolate numeric elevations, never the encoded RGB channels.
  let a = textureLoad(height, clamp(base, vec2i(0), dimensions-1), 0).rg;
  let b = textureLoad(height, clamp(base+vec2i(1,0), vec2i(0), dimensions-1), 0).rg;
  let c = textureLoad(height, clamp(base+vec2i(0,1), vec2i(0), dimensions-1), 0).rg;
  let d = textureLoad(height, clamp(base+vec2i(1,1), vec2i(0), dimensions-1), 0).rg;
  let elevation = mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
  if (tile.size.x > 0.5 && elevation.r >= 0.0) { discard; }
  return vec2f(elevation.r,select(elevation.g,1.0,tile.size.x>0.5));
}`;
export const toneShader = `
@group(0) @binding(0) var height: texture_2d<f32>;
struct Settings { land: vec4f, ocean: vec4f }
@group(0) @binding(1) var<uniform> settings: Settings;
@group(0) @binding(2) var buildings: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0, 1);
}
@fragment fn fragment(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let surface = textureLoad(height, vec2i(pixel.xy), 0).rg;
  let encodedBuilding = textureLoad(buildings,vec2i(pixel.xy),0).rg * 255.0;
  // RG is a 16-bit decimetre value. Dividing by ten to metres and applying
  // the requested 10x exaggeration cancel, so the encoded integer is metres.
  let elevation = surface.r + encodedBuilding.r*256.0 + encodedBuilding.g;
  if (elevation < -1e10) { return vec4f(0.013, 0.013, 0.013, 1); }
  let window = select(settings.land,settings.ocean,surface.g>0.5);
  let limit = max(1.0,settings.land.y);
  let t = 0.25 + 0.5*(elevation-window.x) / max(1.0,window.z-window.x);
  // Keep the measured terrain window in the 25–75% tone interval.
  // Reserve black/peak headroom for outliers instead of broad flat clipping.
  let radiance = exp(mix(log(0.01),log(-limit*log(0.04)),t))*exp2(f32(${TERRAIN_EXPOSURE_STOPS}));
  // A monotonic shoulder preserves contrast without clipping bright summits.
  let normalized = 1.0 - exp(-radiance / limit);
  let anchorRadiance = exp(mix(log(0.01),log(-limit*log(0.04)),0.25))*exp2(f32(${TERRAIN_EXPOSURE_STOPS}));
  let anchored = 1.0-exp(-max(0.0,radiance-anchorRadiance)/limit);
  let luminance = select(${LAND_MIN_LINEAR} + (limit-${LAND_MIN_LINEAR})*anchored,
    ${OCEAN_MAX_LINEAR}*(limit*normalized)/(${OCEAN_MAX_LINEAR}+limit*normalized), surface.g > 0.5);
  // rgba16float canvas values use the configured sRGB transfer function.
  // Encode exactly once at presentation; all preceding math stays linear.
  let encoded = select(12.92*luminance,1.055*pow(luminance,1.0/2.4)-0.055,luminance>0.0031308);
  return vec4f(vec3f(encoded), 1);
}`;
export const meterShader = `
@group(0) @binding(0) var height: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> meter: Meter;
@group(0) @binding(2) var buildings: texture_2d<f32>;
struct Meter { landBins: array<atomic<u32>,256>, oceanBins: array<atomic<u32>,256>, landLow: atomic<u32>, landHigh: atomic<u32>, depthLow: atomic<u32>, depthHigh: atomic<u32>, landToneLow: atomic<u32>, landToneHigh: atomic<u32> }
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 128u || id.y >= 72u) { return; }
  let dimensions = vec2f(textureDimensions(height));
  let pixel = vec2i((vec2f(id.xy) + 0.5) / vec2f(128,72) * dimensions);
  let surface = textureLoad(height, pixel, 0).rg;
  let terrainElevation = surface.r;
  if (terrainElevation < -1e10) { return; }
  let encodedBuilding = textureLoad(buildings,pixel,0).rg*255.0;
  let buildingElevation = encodedBuilding.r*256.0+encodedBuilding.g;
  let toneElevation = select(terrainElevation,terrainElevation+buildingElevation,surface.g<=0.5);
  let bin = u32(clamp((toneElevation + 12000.0) / 22000.0 * 256.0, 0.0, 255.0));
  if (surface.g <= 0.5) {
    atomicAdd(&meter.landBins[bin],1u);
    atomicMax(&meter.landLow,bitcast<u32>(max(0.0,20000.0-terrainElevation)));
    atomicMax(&meter.landHigh,bitcast<u32>(terrainElevation+20000.0));
    atomicMax(&meter.landToneLow,bitcast<u32>(max(0.0,20000.0-toneElevation)));
    atomicMax(&meter.landToneHigh,bitcast<u32>(toneElevation+20000.0));
  } else {
    atomicAdd(&meter.oceanBins[bin],1u);
    let depth = max(0.0,-terrainElevation);
    atomicMax(&meter.depthLow,bitcast<u32>(max(0.0,20000.0-depth)));
    atomicMax(&meter.depthHigh,bitcast<u32>(depth+1.0));
  }
}`;

// Bathymetry supplies a number, never the shoreline classification. In
// particular, negative ocean DEM pixels must not paint over lakes or land.
export const composeElevationShader = `
@group(0) @binding(0) var surface: texture_2d<f32>;
@group(0) @binding(1) var bathymetry: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv*2.0-1.0,0,1);
}
@fragment fn fragment(@builtin(position) pixel: vec4f) -> @location(0) vec2f {
  let land = textureLoad(surface,vec2i(pixel.xy),0).rg;
  let ocean = textureLoad(bathymetry,vec2i(pixel.xy),0).rg;
  if (land.r > -1e10) {
    if (land.g > 0.5 && ocean.r > -1e10) { return vec2f(ocean.r,1); }
    return land;
  }
  return ocean;
}`;
