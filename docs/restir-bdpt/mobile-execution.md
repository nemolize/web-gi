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
must not become history. Tiled execution reports wall-clock frame duration in the live stats. During
performance capture, it also records timestamps for each tile and denoising /
presentation pass when the device exposes `timestamp-query`.

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

## Compile-time device loss

Two Fold 7 / Chrome 140 reports for preview `27d0f873` lose the device while
compiling `bdpt-spatial` at 8x8, before the first frame. The spatial compilation
ran for approximately 4.1 and 7.7 seconds; these reports do not establish a fixed
timeout or identify the underlying browser/driver failure. The 4096-pixel
submission cap applies to execution, not pipeline compilation.

Use `?restir=bdpt&bdptWorkgroupSize=4` to start every BDPT pipeline at 4x4,
retaining the 1x1 fallback for internal pipeline errors. Use
`bdptWorkgroupSize=1` to compile only 1x1. Missing or invalid values start at 4x4 on Qualcomm / Adreno and at 8x8
on other adapters. `bdptWorkgroupSize=8` explicitly restores the larger sequence. The renderer reports the requested limit, and pipeline
cache keys include it. Device loss remains an error; a smaller attempt on the
same lost device is not a recovery mechanism.

Fold 7 testing confirmed continued rendering at 4x4. After temporal history
was isolated from spatial reuse, the user confirmed that progressive white
clipping stopped, with reported latency remaining about 2200 ms. These are
user observations, not matched performance measurements.

## Measuring the normal tiled renderer

Open the normal BDPT preview and use **Measure**, then **Copy result**. The
three captures each discard warmup frames before a five-second sampling window.
Warm-up ends at 30 frames or 6 seconds, whichever comes first, with a two-frame
minimum, so a 2200 ms/frame device discards 3 frames rather than 30. The budget
scales down with the reported frame time, leaving a fast device at its full 30
frames. Keep the page visible and the camera and settings fixed. The capture
timeout and interruption threshold allow slow BDPT frames.

`runs[].measurement.sampling` reports `warmupFrames` actually discarded beside
the `warmupBudgetMs` they ran under, so a truncated warm-up is visible in the
report rather than inferred from frame duration.

The copied `runs[].measurement.passMs` aggregates GPU timestamps for camera
paths, light paths, gathering, caustic reprojection, temporal reuse, spatial
reuse, resolve, and each denoising / presentation pass. All tiles retain normal
submission ordering and completion waits. Timestamp queries are resolved before
reuse, with one buffer readback after the complete frame. `frameMs` spans the
first GPU pass through presentation, including gaps between submissions; the
sum of `passMs` measures pass execution only. Their difference includes
submission gaps and work outside pass brackets, not just CPU overhead. The
ordinary frame statistic also includes command encoding and measurement
readback. Timestamp collection adds overhead and is enabled only for capture.

Devices without `timestamp-query` retain the explicit `wallFallback` report;
no per-stage GPU timings are claimed. Explicit workgroup and dispatch overrides
are retained in the sanitized report URL.
