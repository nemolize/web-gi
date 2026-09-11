# BDPT resampling coordinates

`bdpt-candidate.wgsl` returns a Monte Carlo contribution before technique MIS:
subpath throughputs already include reciprocal sampling probabilities.
These values are estimators, not the paper's unweighted path-space contribution.
For reservoir integration in primary-sample coordinates, use the target
`luminance(estimator) * techniqueMisWeight`. The initial contribution weight is
one for a camera technique and `1 / globallyLaunchedLightPaths` for a light
technique. Compressing several initial candidates adds its own reservoir weight.

`createBdptInitialPasses` generates a camera subpath and a paired light subpath
per pixel. A separate light-tracing pass launches one additional light subpath
per pixel; `lightPathCount` reports this latter count for normalization.
Its dimensions must match the scene uniform. Light-tracing prefixes are compressed into
separate normal and caustic samples, then routed through per-pixel linked lists.
The gather pass sums the already-normalized estimates without dividing by the
number of arrivals. Both output reservoirs have confidence one, even if empty.
List heads are cleared before each frame; gathering runs after light generation.

Candidate evaluation and replay share an ordered camera-to-emitter depth check.
After the last permitted diffuse vertex, only a direct emitter connection is
accepted, matching Reference PT's stopping rule. The total step allowance is
also bounded by the BDPT vertex capacity.

The technique remains part of the sample during reuse. Replaying a camera
prefix with its original random variables and reconnecting it to the unchanged
light prefix is the identity map in these coordinates, with Jacobian one.
Camera-only paths replay their entire prefix.

For a non-caustic light-tracing sample, preserve its subpixel film offset and
move its last vertex to the primary surface at the destination pixel. Keep the
preceding light prefix fixed. Let `qA` be the density with which that prefix
samples the last vertex, and `cA` the camera's conditional-pixel area density.
The forward Jacobian in primary-sample coordinates is

```
J = (qA_destination / qA_source) * (cA_source / cA_destination).
```

The first ratio converts the endpoint-area map back to light-sampling
coordinates. The second is the area Jacobian for preserving film coordinates.
The reverse map must recover the source endpoint and reciprocal Jacobian.
Emitter-only paths use emitter selection per area for `qA`.

Light-tracing samples whose preceding vertex is delta use replay only and
cannot move to an arbitrary spatial neighbor. `bdptShiftCaustic` replays the
light path for the destination camera, letting the endpoint projection select
its new pixel. The random-variable map has Jacobian one. Normal reservoirs
use `bdptShiftBetweenCameras` for temporal shifts and `bdptShiftReplay` for
same-camera spatial shifts.

`bdptTemporalReservoir` combines estimates from the same pixel domain using
confidence-weighted averaging. Empty reservoirs retain their confidence and
contribute zero radiance. This shortcut requires an unchanged camera. All reuse
requires an unchanged scene, resolution, and sampling budget; callers must
discard history when those change.
The history confidence cap affects the averaging weight, not the cached estimate.

`createBdptPasses` records initial sampling, caustic reprojection, temporal
merging, and pairwise spatial resampling. Its `reservoirs` getter returns the latest output
after `record`. `resetHistory` clears both history buffers on the next recording;
the caller must invoke it when the scene or sampling budget changes. Resolution
changes require destroying and recreating the passes at the new dimensions.
The scene uniform must contain the current and previous frame's cameras.

During camera motion, normal temporal reuse uses pairwise MIS with forward and
reverse shifts. Replayed caustic samples are routed through per-pixel linked
lists. Their MIS weights use the source reservoir's confidence and the current
initial reservoir's confidence. The accumulated caustic confidence instead uses
a proxy from diffuse surface reprojection, independently of how many samples
land in the pixel, as described in the paper's Section 5.1 and Appendix A.

Spatial reuse applies only to normal reservoirs. Geometry-compatible neighbors
are selected independently of their reservoir samples. Pairwise MIS scales the
center confidence by the requested neighbor count, includes a defensive center
term, and normalizes by the accepted neighbor count plus one. Reverse shifts
provide the competing density for the center sample. Empty neighbors still
contribute confidence. The resulting confidence is capped by `maxHistory`;
caustic reservoirs pass through spatial reuse unchanged.

These passes currently run in the development browser probes. The paper's
camera-side hybrid shift, which reconnects at consecutive rough vertices and
preserves the remaining suffix, is not implemented: camera prefixes currently
use full random replay. That mapping and application renderer integration remain
pending. Animated scene geometry is not supported by the replay history.

`bdptMisEdgeFactor` produces relative scores using the delta-zero remapping
convention of BDPT. Those scores must never be used as absolute proposal PDFs
or substituted for the shift's `qA` and `cA`.

References: [ReSTIR BDPT](https://research.nvidia.com/labs/rtr/publication/hedstrom2025restir/)
and [PBRT's BDPT density and MIS implementation](https://github.com/mmp/pbrt-v3/blob/master/src/integrators/bdpt.cpp).
