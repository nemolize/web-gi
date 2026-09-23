# Rejected spatial replay experiments

## Center light-prefix reuse (PR #214)

[PR #214](https://github.com/nemolize/web-gi/pull/214) grouped inverse spatial
shifts before forward shifts to retain the center light subpath. It was closed
without merging after user-supplied Galaxy Z Fold 7 measurements reproduced a
regression. The desktop improvements do not establish an Adreno improvement.
[Issue #208](https://github.com/nemolize/web-gi/issues/208) remains open.

The baseline preview `ceaabed4` has the same source tree as `5251eb5`; the
optimized preview `afbcd20b` contains `0a85a97`. Reported settings matched:
classic, 353x738 output, 480x1003 viewport, DPR 2.25, four spatial neighbors,
three bounces, 4096-pixel dispatch cap, and denoising enabled.

| Capture (UTC, 2026-09-17) | Version          | Frame ms | Spatial ms |
| ------------------------- | ---------------- | -------: | ---------: |
| 15:17:40                  | Optimized        |  1054.21 |     653.00 |
| 16:42:33                  | Baseline         |   790.50 |     456.59 |
| 16:44:31                  | Optimized repeat |  1057.55 |     645.60 |

Values are medians of the three per-run medians. The adjacent captures differ
by +33.8% in frame time and +41.4% in spatial time. All reports have complete
timestamp coverage and no report warnings. Unchanged passes also slowed, so
these captures do not isolate shader cost from device-wide conditions or prove
a cause such as register pressure or thermal throttling. The adjacent reports
omit an explicit workgroup override and do not record effective workgroup size
or adapter metadata. The result rejects this candidate; it is not a controlled
estimate of its isolated GPU cost.

## Splitting source replay into four dispatches

A disposable diagnostic prototype was tried against `5251eb5` on M2 Max / Metal
3 / headed Chrome 152. It froze the normal temporal reservoirs after ten
production frames at 48x64 and replayed each stored source once. The reference
called the unchanged `bdptReplay` with independent light-path reconstruction.
The split executed light generation, camera replay, candidate connection, then
MIS and final replay bookkeeping. Every semantic output field was serialized
and compared bit-for-bit against the reference; both scenes had zero mismatches
and 3072 positive estimators.

WGSL's function-local workspace was serialized into storage between dispatches:
2568 bytes per pixel in classic (capacity 10), and 5164 in glass (capacity 21).
Four warmup pairs preceded twelve pairs alternating reference/split order.
The table contains median GPU-pass timestamps in milliseconds. The ratio is
sum of the four stage medians divided by the reference median.

| Scene / neighbors / bounces | Reference | Light | Camera | Connection | MIS + finish | Split / reference |
| --------------------------- | --------: | ----: | -----: | ---------: | -----------: | ----------------: |
| Classic / 4 / 3             |     0.175 | 0.368 |  0.647 |      0.596 |        0.326 |            11.04x |
| Glass / 8 / 6               |     0.484 | 0.881 |  1.469 |      1.361 |        0.730 |             9.18x |

This split is rejected as a bottleneck attribution tool. It adds storage traffic
and changes compilation substantially; the experiment does not isolate which
of those effects causes the inflated sum. Glass also showed pronounced drift
within the measurement window. Ranking the four medians would rank these
instrumented kernels, not the costs inside the production replay function.

The workload excludes destination shifts, the cached light-prefix path,
caustic-reservoir replay, camera motion, and the full spatial neighbor loop.
Even a low-overhead split of this source-only workload would not establish
production spatial cost shares. Output equality establishes only the tested
source-replay equivalence. The prototype was removed; production shaders and
the existing spatial-selection profiler remain unchanged.

## Gate for the next diagnostic

Capture the actual forward/inverse replay calls and their source state before
choosing a performance lever. Include successful and rejected shifts, light-
and camera-side techniques, reconnections and light-prefix reuse. Preserve the
original output on frozen inputs, and compare the combined diagnostic cost to
the unsplit workload. If instrumentation dominates or changes the workload,
report that limitation instead of deriving production cost percentages.

A trustworthy within-replay breakdown remains unfinished. Any subsequent
optimization needs an early Fold comparison with recorded effective workgroup
and adapter metadata, followed by repeated same-condition whole-frame timings.
