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
cannot move to a spatial neighbor. `bdptShiftReplay` currently assumes the same
camera for both domains; it does not implement camera-motion reprojection of
caustic reservoirs.

`bdptTemporalReservoir` combines estimates from the same pixel domain using
confidence-weighted averaging. Empty reservoirs retain their confidence and
contribute zero radiance. Its cached estimates require unchanged scene, camera,
resolution, and sampling budget; callers must discard history when those change.
The history confidence cap affects the averaging weight, not the cached estimate.

`bdptMisEdgeFactor` produces relative scores using the delta-zero remapping
convention of BDPT. Those scores must never be used as absolute proposal PDFs
or substituted for the shift's `qA` and `cA`.

References: [ReSTIR BDPT](https://research.nvidia.com/labs/rtr/publication/hedstrom2025restir/)
and [PBRT's BDPT density and MIS implementation](https://github.com/mmp/pbrt-v3/blob/master/src/integrators/bdpt.cpp).
