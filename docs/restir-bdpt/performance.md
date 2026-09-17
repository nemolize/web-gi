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
optional dispatch pixel cap (zero disables batching), and baseline capacity mode
(`32` by default for historical comparisons, or `matched` for revisions that
already specialize capacity). The tool uses installed
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

## Vertex capacity and budget pruning (2026-09-13)

The renderer now sizes function-local path/MIS arrays to
`min(32, maxBounces + 3 + max(4, glassShapeCount * 4))`, the same bound already
used by candidate evaluation. This is 10 vertices for classic at three bounces
and 21 for the three-glass-shape scene at six bounces. It preserves the supported
path set while giving the compiler smaller arrays. Register allocation and
spilling were not measured, so the timings do not identify the driver's exact
mechanism.

Pipeline cache keys include capacity. Scene/depth changes discard stale pending
initialization, reset history, and select the matching pipelines. Direct callers
that omit capacity retain 32 vertices, including existing diagnostics.

Subpath construction also stops beyond the existing diffuse budget. Camera
paths retain the sampled direct-emitter continuation after the last permitted
diffuse vertex; light paths need no further endpoint after that budget. The
frozen unbounded-subpath fixture checks every enumerated candidate against the
optimized builder at 1, 3, 6, and 12 bounces, including glass transport. GPU
integration checks exercise capacities 10, 16, 21, and 27, changing scenes/depth
while compilation is pending. Raw specialized glass initialization and reuse
are checked against Reference PT, including motion and history clearing.

The presentation transition now consumes elapsed time without a per-frame 25%
cap. A slow completed frame can finish the 120 ms blend immediately, rather
than retaining coarse history for at least four more frames. This does not
change the fixed-resolution performance measurements.

The measurement tool normalizes the capacity declaration only for source
verification and restores 32 vertices for the baseline. Optimized shader code
is passed through unchanged; the report records compiled capacities. Baseline
`192244a` includes the earlier spatial-source preparation. Keep all GPU tests
and other rendering tabs closed during the interleaved measurements. Restart
the dev server if its cached raw shader imports fail source verification.

Two earlier experiments were not retained: eager candidate rejection regressed
classic cadence by about 3%, and scalar MIS density ratios improved it by only
about 1.5% while adding a numeric fallback. The paper's cached recursive MIS
and partial-suffix replay remain separate work.

### Production integration measurements

O2.local, Apple M2 Max, Chrome 152 / Metal 3, viewport 430x900 at DPR 2.25,
render size 352x738. Default denoising and temporal/spatial reuse are enabled.
The interleaved three-run means below include all unchanged passes and GPU
completion waits. Each run warmed ten frames and measured at least thirty.

| Scene / neighbors / bounces / dispatch cap | Baseline runs (ms/frame) | Optimized runs (ms/frame) | Reduction |
| ------------------------------------------ | ------------------------ | ------------------------- | --------- |
| Classic / 4 / 3 / none                     | 113.53, 119.02, 116.14   | 64.69, 65.76, 64.40       | 44.1%     |
| Glass / 8 / 6 / none                       | 273.38, 281.32, 275.03   | 197.24, 199.38, 204.99    | 27.5%     |
| Classic / 4 / 3 / 4096 pixels              | 423.79, 423.83, 426.00   | 256.67, 263.80, 264.98    | 38.3%     |

Classic changed from 8.6 to 15.4 frames/s; heavy glass from 3.6 to 5.0 frames/s.
The optimization is substantial on this GPU but does not make the heavy glass
configuration real-time. Fold 7 and M4 Air remain unmeasured. The batched row
measures Adreno's submission strategy on the M2 Max, not Fold performance or
compatibility; its conservative dispatch limit is unchanged.

## Immediate light replay and streaming MIS (2026-09-13)

`bdptShiftBetweenCameras` now reuses the seeded light prefix left by its
immediately preceding `bdptPrepareShift`. Destination camera replay and light
endpoint replacement still run. Cached center sources continue rebuilding the
light subpath: their workspace may have been overwritten by another neighbor.
This avoids adding an owned subpath copy to the prepared source.

MIS accumulates the forward log density and zero count while consuming technique
scores, removing two function-local arrays. Reverse densities retain their
existing arrays. The arithmetic and technique accumulation order are preserved;
this is not the paper's cached recursive MIS method. Samples, path budgets,
visibility, Jacobians, denoising, resolution, and dispatch limits are unchanged.

The CPU density-product oracle covers capacities 10, 21, 27, and 32, with zero
densities, delta vertices, and zero light samples. Replay checks compare immediate
reuse with independent rebuilding through eight shifts and return shifts, both
with stationary and moved cameras, including camera reconnection and replaced
light endpoints.

Use baseline `ce5d332` with matched capacities to avoid counting the earlier
workspace specialization again:

```sh
node e2e-tests/measure-bdpt.mjs http://127.0.0.1:5197 ce5d332 result.json classic 4 3 0 matched
node e2e-tests/measure-bdpt.mjs http://127.0.0.1:5197 ce5d332 glass.json glassShapes 8 6 0 matched
node e2e-tests/measure-bdpt.mjs http://127.0.0.1:5197 ce5d332 batched.json classic 4 3 4096 matched
```

Same M2 Max / Chrome 152 / Metal 3 environment and 352x738 render size as above.
Each row includes three interleaved runs per variant, ten warmup frames, at least
thirty measured frames, and all unchanged rendering and submission costs.

| Scene / neighbors / bounces / dispatch cap | Baseline runs (ms/frame) | Optimized runs (ms/frame) | Reduction |
| ------------------------------------------ | ------------------------ | ------------------------- | --------- |
| Classic / 4 / 3 / none                     | 66.41, 63.77, 65.87      | 59.31, 63.66, 65.53       | 3.8%      |
| Glass / 8 / 6 / none                       | 200.11, 198.71, 195.14   | 173.26, 174.95, 171.35    | 12.5%     |
| Classic / 4 / 3 / 4096 pixels              | 264.31, 254.98, 263.85   | 254.95, 247.72, 247.74    | 4.2%      |

Heavy glass improves from 197.98 to 173.19 ms/frame (5.1 to 5.8 frames/s).
Light-prefix reuse alone measured about 3% in classic and 4% in heavy glass;
removing the forward MIS arrays accounts for the larger combined glass gain.
The classic gain is small relative to its run-to-run spread. These desktop
results do not establish Fold 7 performance or compilation compatibility, and
the heavy glass scene remains below interactive frame rates.

## Profiling inside spatial reuse (#208)

Use the development-only probe to price neighbor selection separately from the
remaining replay and reservoir work, on the same frozen production inputs:

```sh
node e2e-tests/measure-bdpt-spatial.mjs http://127.0.0.1:5198 classic.json
node e2e-tests/measure-bdpt-spatial.mjs http://127.0.0.1:5198 glass.json glassShapes 8 6
```

Close other rendering tabs and run these serially. Arguments after the output
path are scene, attempted neighbors, bounces, width, and height. The default is
classic / 4 / 3 at 352x738. The tool opens a headed Chrome with its own temporary
profile, requires WebGPU with `timestamp-query`, and forces untiled
full-image dispatches. It fails on unsupported timing, empty radiance, an empty
neighbor workload, shader-source drift, or differing output; a missing adapter
is not a successful measurement. Verify the reported adapter is the hardware
you intend to measure; software adapters are not rejected. Restart the dev
server after editing the probe, because its files live outside `src`.

Ten completed production frames populate history. The probe retains the final
spatial pass's pipeline, uniforms and bindings, then stops advancing the renderer.
All variants read that same input. A diagnostic shader split stores selected
neighbor coordinates and RNG state in a 272-byte-per-pixel buffer. The second
pass restores them and executes the unmodified replay/reservoir suffix. Before
measurement, every output word must match the original production pass, including
caustics. Selection-disabled, classic, and heavy glass GPU tests exercise this
check. No production shader, estimator or renderer setting is changed.

The report records twelve pairs after four warmup pairs, alternating original /
selection+replay order. Times are GPU pass timestamps in milliseconds; readback,
compilation, other passes and CPU/submission gaps are excluded. Selection includes
primary hits, rejection, deduplication and intermediate writes; replay includes
intermediate reads, source preparation, forward/inverse shifts, MIS and reservoir
updates. The split sum can differ from the original because storage traffic and
compiler decisions change. Compare that sum to the original before interpreting
the split: these are diagnostic costs, not an exact additive decomposition of the
production kernel or an end-to-end speedup. The frozen history is one frame, not a
sample of motion or long-running convergence.

Apple M2 Max / Apple Metal 3 / Chrome 152, at 352x738 and workgroup 8x8,
gave these medians across twelve pairs (milliseconds). The final column compares
the sum of the selection/replay medians to the original median:

| Scene / neighbors / bounces | Original | Selection | Replay | Split sum vs original |
| --------------------------- | -------: | --------: | -----: | --------------------: |
| Classic / 4 / 3             |    34.35 |      0.56 |  35.22 |                 +4.2% |
| Glass / 8 / 6               |    78.91 |      0.78 |  76.95 |                 -1.5% |

Both outputs matched bit-for-bit. Classic had 213,643 active pixels and 618,355
accepted neighbors; glass had 187,612 and 922,050. An earlier separate browser
run put the split sums 0.6% and 1.0% below
production respectively; this variability is another reason not to call the
split a speedup. Across both runs, selection remains below 1 ms and the replay
suffix dominates. This supports investigating replay cost on this desktop. It
does not establish the split on Fold 7, the
benefit of a particular replay optimization, or a whole-frame speedup. #208
remains open for those measurements and the subsequent optimization.
