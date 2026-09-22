# Inverse preparation and application

`?diagnostics=bdpt-inverse-prepare` compiles `bdptPrepareShift` alone.
`?diagnostics=bdpt-inverse-apply` compiles `bdptApplyShift` alone, loading
synthetic prepared metadata from runtime storage inputs. Both use capacity 10,
workgroup 1x1, and a new device; neither allocates buffers or dispatches work.
Restart the browser after device loss before trying the other suite.

Preparation writes every returned field consumed by application to storage.
Application reads those fields from storage and writes its shifted sample,
candidate, PDF terms, film, caustic flag, and Jacobian. This keeps relevant
helper results observable to the compiler without inventing constant paths
that could eliminate branches. Unused endpoint/predecessor hit records are
omitted because application does not read them.

These remove the spatial neighbor loop and its guards as well as the other
helper. Synthetic metadata does not represent a valid rendered path, and
application's workspace starts empty (`bdptApplyShift` rebuilds its paths).
A pass narrows the next experiment but does not establish rendering correctness
or prove either helper safe when combined. Cache reuse remains possible.

These helpers are also used by other replay paths; the probes isolate shared
code used by the inverse path, not inverse-exclusive calculations.

`?diagnostics=bdpt-inverse-combined` calls preparation once, then feeds its
actual result to one application call in the same shader and workspace.
It shares the standalone probes' input layout, runtime destination, output
writes, vertex capacity, and workgroup size. No spatial neighbor loop or
renderer resources are included. Compare with both standalone helpers:
a failure here reproduces without the neighbor loop; a pass leaves combined
code inside the spatial loop and surrounding control flow untested. Source
calls remain subject to compiler optimization and caching.

`?diagnostics=bdpt-spatial-inverse-one-neighbor` starts from the inverse-only
`bdpt-spatial-no-forward` variant and changes only the source replay loop bound
to one neighbor. Neighbor discovery, preparation, inverse guards, and pairwise
weight/output calculations remain in the source. The existing `count == 1`
early return still skips pixels with no accepted neighbor. This is a compiler
reduction, not a correctly normalized rendering mode. Compare against
`bdpt-spatial-no-forward` from the same preview; unlike `bdpt-inverse-combined`,
it retains spatial's surrounding control flow. A passing reduction implicates
loop-dependent compilation but does not prove a driver mechanism or exclude
cache/state effects.

`?diagnostics=bdpt-spatial-inverse-two-neighbors` uses a constant two-slot replay
loop bound. A guard skips a slot before reading `domains[sourceIndex]` when
fewer than two neighbors were discovered; the no-neighbor return remains.
Compare with `inverse-one-neighbor` and `no-forward` from the same preview.
This adds a guarded second inverse replay while preserving discovery and weight
calculations. Actual compiler unrolling is not guaranteed. Success or failure
helps distinguish a fixed small bound from the original variable bound, but
cannot by itself identify a driver defect or prove a general resource limit.

`?diagnostics=bdpt-inverse-combined-twice` prepares once and explicitly applies
twice in separate source blocks, sharing the prepared result and workspace.
The destinations come from two runtime input fields. Each result is stored
in a separate output slot so the first write is not overwritten or dead.
This removes only the outer replay loop; helper-internal loops remain.

For a closer loop comparison, `?diagnostics=bdpt-inverse-combined-loop-two`
uses the same inputs, destinations, output slots, and workspace but calls
application inside a fixed two-iteration loop. Neither probe includes spatial
neighbor discovery, pairwise weighting, or neighbor-availability guards.
Both remain compilation-only with capacity 10 and workgroup 1x1. A difference
between the pair implicates their compilation structure, not necessarily the
original spatial loop; optimizer transformations and cache/state effects remain
unmeasured. A pass does not establish valid rendered output from synthetic inputs.

`?diagnostics=bdpt-spatial-inverse-two-no-discovery` starts from the failing
guarded two-neighbor inverse spatial variant and replaces discovery with two
synthetic adjacent coordinates (wrapped to the render dimensions). The active
slot count comes from reservoir data, allowing zero, one, or two neighbors so
the no-neighbor and slot-availability guards remain runtime-dependent.

Center-surface tracing, RNG initialization, inverse preparation/application,
the two-slot replay loop, pairwise weighting, and output writes remain in the
source. Random neighbor search, duplicate rejection, and neighbor geometric
checks are absent. Tiny render dimensions can produce duplicate synthetic
coordinates; no claim of valid resampling is made. This changes neighbor/count
provenance and RNG consumption as well as discovery code, so a passing probe
identifies a reduction rather than proving that a specific discovery operation
causes the compiler failure. Compare with `inverse-two-neighbors` from the same
preview. No rendering is performed, and compiler optimization/caches remain
unmeasured.

`?diagnostics=bdpt-spatial-inverse-two-direct-output` starts from
`inverse-two-no-discovery` (which also failed on the affected Adreno device).
It removes pairwise weighting, confidence accumulation, reservoir selection,
and finalization. Each inverse result's technique seeds, estimator, MIS weight,
and Jacobian go to a separate member of the output pair: slot one uses `normal`,
slot two uses `caustic`, with the Jacobian stored in `path.weightSum`.
These fields are diagnostic payloads, not valid rendering reservoirs.

The runtime count, slot-availability guard, center-surface checks, preparation
condition, source-confidence guard, and shared workspace remain. Separate output
members keep the first result observable when the second slot runs. This changes
output data flow and loop-carried state as well as weight calculations; a pass
would not prove a specific weighting operation caused the failure. Compare with
`inverse-two-no-discovery` from the same preview. Compilation only, no dispatch;
compiler optimization and cache behavior remain unknown.

`?diagnostics=bdpt-spatial-inverse-two-no-surface` reduces `inverse-two-direct-output`
(which also failed on the affected Adreno device). It removes the center's primary
surface trace and its miss/material early return. All remaining source is unchanged:
dispatch bounds, feature flags, runtime count and slot guards, conditional inverse
preparation/application, shared workspace, and separate direct outputs remain.
Replay-internal scene tracing is still present. This removes both a trace and its
control dependency, so a difference cannot distinguish trace complexity from the
early return's compilation effects. This is a compilation probe, not a rendering
fix; compare with `inverse-two-direct-output` on the same preview. Optimizer and
cache behavior remain unmeasured.

`?diagnostics=bdpt-spatial-inverse-two-surface-no-gate` returns to
`inverse-two-direct-output`, retaining the center surface trace but replacing its
early return with an observable predicate. The original miss/material predicate
is encoded as 0 or 1 in `normal.path.confidence`, written both before the
no-neighbor return and after replay so neither path discards it. All other guards,
shared workspace, inverse calls, and separate inverse output payloads remain.

The no-surface reduction passed on the affected Adreno device (1776 ms), whereas
direct-output failed. This probe tests the trace without making inverse replay
conditional on its result. It changes control and output data flow; compiler
scheduling, register pressure, and caching remain unmeasured. A pass would narrow
the source-level trigger, not establish a driver mechanism. Compare both preceding
variants on the same preview. These remain compilation-only diagnostic payloads,
not valid rendering modes.

`?diagnostics=bdpt-spatial-inverse-two-surface-with-gate` is the matched control
for `inverse-two-surface-no-gate`, which passed on the affected Adreno device
(2331 ms). It retains exactly the same predicate output writes and adds the
original miss/material early return immediately after the first predicate write.
The no-gate variant's generated source remains unchanged. Compare this pair on
the same preview to separate the source-level gate change from the added output
writes. The gate intentionally prevents replay on rejected surfaces; all other
source, bindings, and constants match. A differing outcome still does not establish
which compiler transformation fails, and cache/state effects remain possible.

The matched surface-gate control passed on Adreno (2178 ms), while the unchanged
`inverse-two-direct-output` failed again on that same preview (2276 ms).
Two further reductions each remove one predicate-output assignment from the
passing control, keeping the surface trace, early return, and inverse payloads:

- `?diagnostics=bdpt-spatial-inverse-two-surface-pre-output` stores the predicate
  before the gate only. The final pair write overwrites it when replay completes;
  it remains observable on the surface-rejection and no-neighbor return paths.
- `?diagnostics=bdpt-spatial-inverse-two-surface-final-output` stores the predicate
  at the end only. Early-return paths retain the original center output. At the
  final write the surface has passed the gate, so the predicate must be zero and
  a compiler may fold it to a constant.

Neither reduction promises identical optimized tracing or control flow. They test
which source-level output assignment affects compilation, not a driver mechanism
or valid resampling. Compare each with `inverse-two-surface-with-gate` and the
unchanged direct-output control on the same preview; restart the browser after
any device loss. Compilation only, no rendering, and cache effects remain possible.

The pre-only predicate output failed on Adreno (2967 ms); final-only passed
(2473 ms). Continue with the [final confidence probes](#final-confidence-compilation-probes)
to compare constant output with a value-preserving final assignment.

## Final confidence compilation probes

Both variants derive from `bdpt-spatial-inverse-two-direct-output`, adding one
assignment immediately before the final pair write. They retain the center trace,
surface early return, remaining guards, shared workspace, and separate inverse
payloads. Neither includes the predicate-output additions used by the preceding
surface probes. All use capacity 10 and workgroup 1x1 without dispatch or rendering.

- `?diagnostics=bdpt-spatial-inverse-two-final-zero-confidence` writes literal
  `0.0` to `diagnosticOutput.normal.path.confidence`. Compare with
  `inverse-two-surface-final-output`, whose final predicate is zero after the
  surface gate, but whose source still refers to the trace result.
- `?diagnostics=bdpt-spatial-inverse-two-final-restore-confidence` writes
  `center.normal.path.confidence` to the same member at the same location.
  This preserves the direct-output probe's intended output values: its pair
  starts from `center`, and inverse slot one copies `center.normal` before
  changing only sample and Jacobian fields. Slot two changes only `caustic`.
  The final assignment is therefore redundant at source level; a compiler may
  remove it. Early-return outputs are unchanged.

Compare with `inverse-two-direct-output` on the same preview, restarting the
browser between probes, especially after device loss. These compare output values
and assignment structure, not a known compiler mechanism. Cache effects and
optimizer transformations remain unmeasured. The direct-output payload is already
synthetic; preserving its values does not establish correct production rendering.
