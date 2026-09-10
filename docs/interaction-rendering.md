# Interaction rendering

**Smooth camera motion** trades temporary spatial detail for faster orbit and
dolly updates in ReSTIR and Denoised PT. It is enabled by default and can be
disabled in Output. Each dimension is halved after the normal resolution and
memory limits have been applied, leaving approximately one quarter of the pixels.
The selected resolution returns after 200 ms without camera movement.

`src/gi/renderer.ts` separates active dimensions from allocation capacity. The
existing textures and reservoirs hold the smaller image in their active region;
dispatches and shader bounds use those dimensions. Switching sizes resets
accumulation but does not rebuild the GPU buffers, textures, or bind groups.
The canvas backing size changes, and the browser scales its image to the same
CSS rectangle. GPU memory use therefore stays at the full-resolution capacity.

Reference PT stays at the selected resolution. Performance captures use that
resolution even without timestamp queries. An active image comparison freezes
its dimensions until completion. Camera movement still cancels a comparison.

## Why this approach

The initial desktop heavy-scene profile placed GI generation at about 7.4 ms
and the two spatial reuse passes at about 4.8 ms combined, versus about 1.5 ms
for the three denoising passes. Reducing active pixels reduces work throughout
the chain while preserving transport settings and the settled rendering method.

Other approaches remain candidates for separate measured experiments:

- A BVH or wavefront tracer changes ray traversal or scheduling; the current
  small analytic scenes already use cluster bounds, and spatial reuse remains
  a substantial cost outside path generation.
- Replacing ReSTIR with Denoised PT changes the estimator and its convergence.
  Existing renderer comparisons vary with device and condition; the motion
  policy applies to both without making a new quality-winner claim.
- Half-resolution lighting with full-resolution geometry and edge-aware
  upsampling could retain sharper moving silhouettes, but requires new
  reconstruction and history correspondence across two pixel grids.
- Continuous frame-time-driven resolution could address sustained overload
  while stationary, but would need hysteresis and reliable completion timing
  to avoid repeated history resets. This change does not implement a target-FPS
  controller or alter GPU queue pacing.

The accepted costs are softer moving edges and restarting convergence when
motion begins and ends. Full detail returning is not instantaneous convergence;
new samples accumulate after the resolution is restored.

## Desktop measurement, 2026-09-10

Chrome 152, Apple Metal 3, 995×927 CSS viewport, DPR 2. Fixed rendering was
1036×965 pixels; motion rendering was 518×482. Each condition used 30 warm-up
frames followed by five seconds of rendering, awaiting
`GPUQueue.onSubmittedWorkDone()` after every submitted frame. Four paired runs
alternated order. Both conditions alternated the same two nearby camera yaws
(0 and 0.002 radians), keeping camera sampling independent of throughput.
Pass timestamps were off so the shared compute-pass structure was measured.

| ReSTIR settings      | Fixed median per run | Motion median per run | Median reduction |
| -------------------- | -------------------- | --------------------- | ---------------- |
| Default Cornell box  | 8.2 ms               | 2.4 ms                | 71%              |
| Heavy 30-light scene | 17.3–17.4 ms         | 4.7–4.8 ms            | 73%              |

These are submission-through-completion wall times, including command encoding,
GPU work, presentation submission, and completion notification. They are not
display FPS, isolated shader timings, or smartphone measurements. No Android
device was connected for this run. Target-phone frame pacing, thermals, and
perceived transition quality still need device validation.
