# ReSTIR BDPT coordinates and integration

The `ReSTIR BDPT` method is selected inside the ReSTIR renderer, including with
`?restir=bdpt`. It uses camera/light initial sampling, separate normal and caustic
reservoirs, temporal reuse, and pairwise spatial reuse. Scene geometry is static;
scene changes discard history. The supported BSDFs are Lambertian diffuse and
ideal dielectric reflection/transmission.

## Estimator coordinates

`bdpt-candidate.wgsl` returns a Monte Carlo contribution before technique MIS:
subpath throughputs already include reciprocal proposal probabilities. The
reservoir target is `luminance(estimator) * techniqueMisWeight`. Initial camera
techniques have contribution weight one; light techniques use
`1 / globallyLaunchedLightPaths`. Technique indices are preserved during reuse.

`createBdptInitialPasses` generates one camera subpath and paired light subpath
per pixel. A separate light pass launches one additional subpath per pixel;
`lightPathCount` reports this latter normalization count. Light-tracing prefixes
are compressed into normal and caustic samples and routed through linked lists.
Gathering sums their already-normalized estimates without dividing by arrivals.
Both initial reservoirs have confidence one, including empty reservoirs.

Candidate evaluation and replay share Reference PT's ordered depth budget.
After the last permitted diffuse vertex, only a direct emitter connection is
accepted. Full-path technique MIS is recomputed after shifts rather than cached
with the paper's recursive acceleration. `bdptMisEdgeFactor` uses BDPT's
relative delta-zero remapping; it is not an absolute proposal density.

## Hybrid shifts

Camera-side shifts reconnect at the second of the first consecutive rough
camera vertices. The reservoir stores that point and vertex index in
`cameraReconnection`; `coordinates.cameraSurface` stores its quad index and side.
Replaying the prefix consumes the same random draws, replaces the selected
edge, and resumes sampling at the fixed diffuse vertex. Its outgoing Lambertian
sample is independent of the changed incident direction, reconstructing the
remaining suffix without storing all vertices.

Both directions must find the same first eligible pair. The forced edge must
remain visible and hit the same quad side. In primary-sample coordinates its
Jacobian is `qA_destination / qA_source`, where `qA` is the density of sampling
the fixed vertex from its preceding camera vertex. Repeated shifts evaluate
that density from the actual reconstructed source path. When neither path has
an internal pair, random replay has Jacobian one; the existing camera/light
connection supplies the boundary reconnection. Camera-only paths also reconnect
when an eligible pair exists.

A non-caustic light-tracing shift preserves subpixel film coordinates and moves
its last vertex to the destination primary surface, keeping the preceding light
prefix fixed. Its Jacobian is

```
J = (qA_destination / qA_source) * (cA_source / cA_destination).
```

Here `qA` is the light prefix's endpoint-area proposal density and `cA` is the
camera's conditional-pixel area density. The second ratio accounts for the
endpoint-area change when preserving film coordinates.

Caustic light paths, whose preceding vertex is delta, cannot reconnect to an
arbitrary spatial neighbor. Temporal reuse replays their light seeds and lets
the endpoint projection select the destination pixel, with Jacobian one.

## Reuse and lifetime

Temporal normal reuse evaluates forward and reverse mappings for pairwise MIS.
Caustic samples are scattered through per-pixel lists. Their MIS weights use
source and current initial confidence, while accumulated confidence uses a
proxy from diffuse surface reprojection, independently of actual arrivals
(paper Section 5.1 and Appendix A). An unchanged camera permits same-domain
confidence-weighted averaging. Empty history retains confidence.

Spatial reuse selects geometry-compatible neighbors independently of their
samples. Pairwise MIS scales center confidence by requested neighbor count,
includes a defensive center term, and normalizes by accepted neighbors plus
one. Reverse shifts provide competing density for the center. Empty neighbors
retain confidence. Spatial reuse preserves the temporal caustic reservoir.

`createBdptPasses` records initialization, reprojection, temporal merging, and
spatial reuse. Read its `reservoirs` getter after recording. `resetHistory`
clears both histories on the next recording; scene or sampling changes require
this reset. Resolution changes require recreating the fixed-size passes.
Uniforms must contain the current and previous frame's cameras.

## Application output

BDPT resolves full radiance into the existing illumination texture. Presentation,
linear capture, and transition snapshots bypass albedo remodulation and emission
addition for this method. The shared denoiser remains optional; its filtering is
separate from the raw estimator tests. Camera motion resets denoiser history but
retains reservoir history unless adaptive resolution changes.

Direct lighting controls camera–diffuse–emitter paths; indirect lighting controls
longer paths, including glass transport. Primary emitter visibility remains.
Both initial sampling and replay use this partition. The path-reuse controls
apply to BDPT; separate ReSTIR DI candidate/reuse controls are hidden.

Pipelines compile lazily and are cached per device and scene layout. Size-bound
buffers are destroyed on recreation, method changes, and renderer destruction;
stale asynchronous initializations are destroyed on completion. GPU allocation
errors are captured. Render dimensions account for the largest 192-byte binding
stride and total per-pixel allocation: 1,032 bytes for BDPT plus 364 bytes for
existing targets. This retains the existing target-memory budget rather than
allocating the extra buffers at the old pixel limit. This size limit also applies
to reference/comparison modes while the BDPT method is selected.

Internal pipeline compilation failures retry with 4x4 and then 1x1 workgroups
instead of the default 8x8. Each pass dispatches using its successful size,
without changing sampling or depth budgets. Validation errors do not retry;
exhausted retries report all attempted sizes. The original Galaxy Z Fold 7 report failed at all three sizes; shrinking
the workgroup did not resolve that device's Vulkan compiler failure. The v3 report identifies Chrome 140 and Adreno 8xx: traversal,
paired subpaths, MIS-path assembly, standalone MIS, visibility, and isolated
connections compile; candidate evaluation fails even without MIS, at both 32
and 8 vertices. The scalar MIS experiment did not resolve it
and was reverted to avoid its extra edge-factor evaluations.

The permanent [GPU diagnostics](../gpu-diagnostics/README.md) page offers the
BDPT v4 suite through `?diagnostics=bdpt` (legacy `?bdptDiagnostics=1` also works).
Candidate evaluation now passes references to dynamically indexed vertices into
connection helpers instead of copying whole vertex and hit structures. The
transport equations and path budgets are unchanged. The Fold v4 report passes
all 24 compilation probes, including candidate evaluation and initial-camera,
at 32 and 8 vertices with 1x1 workgroups. The execution v2 report also passes
three 39x31 frames, but normal 353x738 rendering loses the device after repeated
half/full-resolution transitions. The renderer now serializes BDPT initialization
and permits only one presented BDPT frame awaiting GPU completion. It logs
SUBMIT/COMPLETE events separately from submitted-frame counters. These changes
prevent overlapping work; Fold device-loss resolution remains unverified.
The `?diagnostics=bdpt-execution` suite runs a small glass scene through
production initialization, reuse, and resolve passes and reports readback
statistics to separate missing radiance from later presentation problems.

References: [ReSTIR BDPT](https://research.nvidia.com/labs/rtr/publication/hedstrom2025restir/)
and [PBRT BDPT](https://github.com/mmp/pbrt-v3/blob/master/src/integrators/bdpt.cpp).
