# BDPT mobile execution

Galaxy Z Fold 7 reports (Chrome 140, Adreno 8xx) narrowed a device-loss failure
to work following a roughly two-second full-frame initial-camera dispatch.
Camera-first execution completed the camera stage, then failed after light
submission. Light-first execution completed light and camera, then failed after
gather submission. These observations do not establish a faulty light/gather
shader or a specific timeout. Vulkan lists execution timeout, platform resource
management, implementation errors and invalid API usage among possible
[device-loss causes](https://docs.vulkan.org/spec/latest/chapters/devsandqueues.html#devsandqueues-lost-device).

## Bounded dispatches

`src/gi/bdpt/pipeline.ts` partitions each BDPT stage into rectangular regions.
The region uniform supplies origin and extent while the scene uniform retains
full image dimensions. Entry points reject workgroup padding against the local
extent, then use global pixel coordinates for RNG, indexing and camera rays.
All tiles of a stage complete before its consumer begins. Light-list and
reprojection-list clears happen once per logical frame, and history parity
advances once per logical frame, not once per tile.

`src/gi/bdpt/frame-submissions.ts` writes each region immediately before its
submission and waits for GPU completion before continuing. The renderer defers
presentation until the final submission and invalidates pending work for
settings or resolution changes. Camera-only motion finishes the captured frame
and retains reservoir history for the next frame's cross-camera reprojection. The completed-frame path controls accumulation; partial frames
must not become history. Tiled execution reports wall-clock frame duration;
ordinary per-pass timestamp queries are not used for this path.

The normal renderer selects a 4,096-logical-pixel dispatch cap for adapters
identified as Qualcomm or Adreno. This is a conservative mitigation, not a
measured optimum. `?restir=bdpt&bdptDispatchPixels=4096` enables the same path
explicitly; `bdptDispatchPixels=0` selects the unsplit path for comparisons.
Explicit nonzero caps are clamped to 64 through 1,000,000 pixels.
The cap does not reduce render resolution, candidate enumeration, path limits,
light-path normalization or reservoir history limits. Rounded workgroups may
contain inactive invocations outside the tile extent.

`?diagnostics=bdpt-batched` runs the same three 353x738 classic frames as the
staged diagnostic with this cap and full-size resources. It excludes normal
presentation and denoising. Compare it with `?diagnostics=bdpt-stages`; changing
submission size alone does not prove the underlying cause of a driver failure.

## Remaining resource uncertainty

At 353x738, the BDPT storage buffers in `initial-passes.ts` and `passes.ts`
use 1,032 bytes per pixel, about 256.40 MiB. The execution diagnostic's two
reservoir readback buffers add about 79.50 MiB before GPU execution. Including
its output texture and padded image readback gives about 340.05 MiB, excluding
scene data, compiled code, driver scratch and allocation granularity. Tiling
retains these resources so its comparison does not also change explicit memory
pressure. Low-resolution success cannot distinguish dispatch duration from
memory-pressure effects.

The source-level 32-vertex workspace is about 10 KiB per invocation before MIS
scratch. This is not a measurement of registers, spilling or resident GPU
memory. Compiler specialization and deferred readback allocation remain
separate investigation options if bounded dispatches still fail.

## Desktop overhead check

On desktop Chrome with Apple Metal, a 430x900 viewport at DPR 2.25 produced a
352x738 classic scene with default BDPT settings and denoising. After eight
warm-up frames, three windows of ten reported frames were measured from the
page's elapsed clock and frame counter:

| Dispatch cap |        Window 1 |        Window 2 |        Window 3 |
| ------------ | --------------: | --------------: | --------------: |
| Disabled     | 128.91 ms/frame | 133.58 ms/frame | 131.15 ms/frame |
| 4,096 pixels | 450.43 ms/frame | 451.73 ms/frame | 451.55 ms/frame |

These are presentation-cadence observations including CPU, GPU and completion
waits, not individual shader timings. Batching increased overhead on this
machine; it is a stability mitigation rather than a speed optimization. The
measurement does not establish Fold recovery or performance.
