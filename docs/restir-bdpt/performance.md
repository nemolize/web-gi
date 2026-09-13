# Spatial replay preparation

Spatial pairwise weighting shifts the center reservoir into each accepted
neighbor's domain. The source sample, source camera, source pixel, and uniforms
are invariant throughout that loop. `bdptPrepareShift` now evaluates that source
once; `bdptApplyShift` rebuilds the destination path for each neighbor. The
prepared value owns its source data and does not retain pointers into the mutable
workspace. Other callers retain the prepare-and-apply convenience wrapper.

This changes neither the neighbor count nor path depth, MIS, visibility,
Jacobians, reservoir weighting, or dispatch limits. It does not implement the
paper's recursive MIS acceleration. Adreno's bounded submissions remain enabled.

## Reproducing a comparison

Run a local development server, close other rendering tabs, then run:

```sh
node e2e-tests/measure-bdpt.mjs http://127.0.0.1:5197 93b3d86 result.json
node e2e-tests/measure-bdpt.mjs http://127.0.0.1:5197 93b3d86 glass.json glassShapes 8 6
```

The arguments after the output path are scene, spatial neighbors, bounces, and
optional dispatch pixel cap (zero disables batching). The tool uses installed
Chrome, opens one rendering tab at a time, verifies settings through the controls,
warms up ten frames, and measures at least thirty accumulated frames per run. Six
runs interleave baseline and working shaders in B/A/A/B/B/A order. Shader creation
checks the served sources against disk; mismatches abort rather than measuring
stale Vite imports. Baseline shaders come from the supplied Git revision and are
substituted only in the benchmark browser. No production mode selector is added.

Results include browser/adapter, host CPU, viewport, render dimensions, effective
settings, per-run frame counts, and elapsed times. Times represent GPU-completion-paced
frame cadence, including CPU work and waits, not isolated GPU timestamps.
For stage localization, `?diagnostics=bdpt-stages` logs completion-wait timings
for each production BDPT stage; `?diagnostics=bdpt-batched` includes tile waits.
Those diagnostic stages exclude denoising and presentation.

## Correctness

The GPU cache probe evaluates the same source against eight destinations while
interleaving independent replay to overwrite the workspace. It compares estimator,
MIS, Jacobian, seeds, film/reconnection coordinates, and destination pixels, and
requires successful camera-side and light-side shifts. Existing GPU tests cover
hybrid reconnection, camera motion, caustics, energy, and history clearing.

Separately generated whole images are not a deterministic cache oracle: parallel
light-path linked-list insertion can change reservoir selection order. The
same-input probe avoids that confound rather than relaxing image tolerances.

## O2.local results (2026-09-13)

Apple M2 Max, Chrome 152, Apple Metal 3, 430x900 viewport at DPR 2.25,
352x738 render resolution, default denoising and temporal/spatial reuse enabled.
Other inspected Chrome sessions contained only blank tabs. Measurements ran
serially with no concurrent GPU tests. Each cell lists three run means in
ms/frame; reduction compares their arithmetic means, including unchanged passes.

| Scene / neighbors / bounces / dispatch cap | Baseline runs          | Prepared-source runs   | Reduction |
| ------------------------------------------ | ---------------------- | ---------------------- | --------- |
| Classic / 4 / 3 / none                     | 129.32, 127.60, 127.75 | 117.74, 119.18, 119.51 | 7.3%      |
| Glass / 8 / 6 / none                       | 290.86, 293.67, 283.33 | 275.22, 271.59, 279.16 | 4.8%      |
| Classic / 4 / 3 / 4096 pixels              | 457.07, 451.05, 450.54 | 423.84, 433.83, 437.69 | 4.7%      |

Initial stage localization at 353x738 (three runs, frames 1–2 after the first
frame) found roughly 70 ms in spatial reuse, 35–40 ms in camera initialization,
and 23 ms in light initialization. With preparation, spatial reuse fell to about
62 ms. These rounded completion-wait timings motivated the change; the full
render measurements above are the performance acceptance evidence.

Fold 7 and M4 Air were not measured for this change. The batched row tests the
submission strategy on O2.local, not Adreno performance or compatibility. This
single-digit overall reduction does not resolve the reported 14 s Fold frame
time. Remaining candidates include recursive MIS acceleration and replay costs;
those require separate correctness checks and fresh measurements.
