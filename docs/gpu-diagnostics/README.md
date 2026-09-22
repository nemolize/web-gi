# GPU diagnostics

Open the **GPU diagnostics** link in the renderer controls, or use
`?diagnostics=core` and `?diagnostics=bdpt`. The older `?bdptDiagnostics=1` link
still selects BDPT. No application renderer mounts on the diagnostics route.

Select a suite, run it, and copy the report. Reports include the browser user
agent, adapter details, suite/version, and each probe's result and compilation
time. Each displayed line includes elapsed seconds since Run, including errors
and Stop. Pending probes emit a WAIT line every five seconds; this confirms the
page timer is active, not that GPU work is progressing. Nothing is uploaded automatically. A failed probe normally allows the
next one to run; device loss, cancellation, or a probe timeout stops
the suite and retains partial results. Compiler probes time out after 30 seconds;
execution probes after 120 seconds. The limit is printed when each probe starts. Compilation success does not establish
rendering correctness or performance.

`src/gi/diagnostics/runner.ts` owns adapter/device lifetime, cancellation,
timeouts, compilation, and reporting. Suites provide compute shader source,
binding layouts, optional override constants, and stable probe labels through
`DiagnosticSuite`. Execution probes instead supply an asynchronous `run(device, report)`
callback; the runner derives the execution label from probe types and owns device cleanup
and cancellation. Register suites in `src/gi/diagnostics/suites.ts`; the selector
and report use the registry. Suite definitions must not access WebGPU globals
at import time, so unsupported browsers can still open the page.

Core WebGPU covers storage writes, dynamic array access, and arrays within
structures. The BDPT suite lives in `src/gi/bdpt/diagnostics.ts` and uses the
production shader prefix with isolated stages. Version 5 first compiles the
production initial-gather shader at 8x8, 4x4, and 1x1, then runs the existing
24 isolated probes. These compilation-only checks exclude renderer target allocations. Its smaller arrays and omitted
MIS are diagnostic variants, never rendering modes. Increment a suite's version
when changing probe meaning, and retain meaningful labels in reports.

Browser checks cover suite selection, the legacy URL, compilation on a real
adapter, retained failures, cancellation, and device loss. Add a real-device
check for new shader probes; capability-gated CI may skip GPU execution.

The `?diagnostics=bdpt-execution` suite runs three 39x31 glass frames using
production BDPT passes, then reads initial/reused reservoirs and rgba16float
resolve output. Each stage reports finite/positive channel counts and mean
radiance. This is a smoke test, not a convergence or full-resolution performance
check, and excludes denoising and canvas presentation.

BDPT execution v2 reports shader validation and each production pipeline
compilation attempt, including the selected workgroup size or retry failure.
A ten-second wait alone does not establish a compiler hang. Inspect the last
COMPILE START without a matching PASS/FAIL; the 120-second limit applies to the
entire execution probe, including compilation and all three frames.

The renderer error overlay also offers **Copy diagnostic report** and an
expandable text field for manual copying. Its frozen snapshot includes browser,
GPU adapter, settings, render dimensions, submitted-frame statistics, timestamped
BDPT initialization events, and the failure. Statistics are captured before
renderer destruction and do not prove GPU completion. Reports retain the first
eight and the most recent 72 event lines with an omitted-line count between
them; the page URL excludes query and hash.
Retry starts a new event history. Clipboard rejection leaves the text available.

For initialization or execution failures specific to the normal renderer, use
`?restir=bdpt&bdptPixels=1209` to cap BDPT render targets at 1,209 pixels while
retaining the production device setup, denoising, and presentation. The cap is
explicit and diagnostic: it only reduces resolution, does not change path
budgets, and does not apply to other ReSTIR methods. The error report records
the requested cap and actual dimensions. Omit it for the normal resolution.
BDPT pipeline compilation is serialized per device, including size retries;
`COMPILE QUEUED` identifies work waiting for earlier compilation. Execution
suite v3 uses this same compiler queue.

To isolate normal-renderer failures before the controls become usable, set
`temporal=off`, `spatial=off`, or `denoise=off` in the URL. Temporal and spatial
overrides set both DI and GI reuse controls; BDPT uses the GI controls. These
initial settings remain editable in the panel and appear in failure reports.
Use `on` to enable a setting explicitly, or omit it for the default. Reuse
shaders still compile and dispatch; the existing disabled branches bypass
resampling. These URLs do not isolate individual GPU submissions or establish
which pass caused a device loss.

The `?diagnostics=bdpt-stages` suite runs three 353x738 classic frames, using
four spatial samples and a 512-frame history limit. Each production BDPT stage
is submitted separately and awaited with `onSubmittedWorkDone`, followed by
initial/reused/resolved radiance readback. `SUBMIT` and `COMPLETE` identify each
stage; a failed completion stops further submissions. This changes GPU
scheduling and excludes normal-renderer allocations, presentation and denoising.
It can narrow a failure, but a pass here does not establish normal-renderer
compatibility. The suite uses the same 120-second execution timeout and Stop
control as the smaller execution suite.

The `?diagnostics=bdpt-light-first` suite uses the same workload and completion
waits as `bdpt-stages`, but submits initial light generation before initial
camera generation. Staged execution v2 moves light-list clearing from the camera
command to the light command in both orders; gather
still follows both producers. Compare reports to distinguish failures that
follow a stage from failures that depend on preceding work. Neither outcome
alone establishes the driver's cause of device loss.

The `?diagnostics=bdpt-batched` suite uses the same full-resolution workload and
allocations, with a 4,096-logical-pixel cap per dispatch. It waits between tiles
and reports stage completion plus periodic tile progress. This preserves image
resolution and path budgets. See [mobile execution](../restir-bdpt/mobile-execution.md)
for the normal-renderer path, comparison switch and remaining resource-pressure
uncertainty.

## Isolated spatial compilation

For device loss while compiling `bdpt-spatial`, run these suites separately:

| URL query                                | Change from production spatial                          |
| ---------------------------------------- | ------------------------------------------------------- |
| `?diagnostics=bdpt-spatial-full`         | None; compile spatial without earlier BDPT pipelines    |
| `?diagnostics=bdpt-spatial-no-inverse`   | Remove center preparation and inverse replay            |
| `?diagnostics=bdpt-spatial-no-forward`   | Remove forward replay and its reservoir update          |
| `?diagnostics=bdpt-spatial-no-replay`    | Remove both replay paths                                |
| `?diagnostics=bdpt-spatial-one-neighbor` | Bound the replay loop to exactly one neighbor iteration |

Each Run requests a new device and compiles one variant with a 1x1 workgroup
and capacity for 10 vertices (the reported classic-scene configuration).
No render targets are allocated and no GPU work is dispatched. The existing
30-second compiler timeout and Stop control apply. Restart the browser after
a device loss before comparing another variant; a new device does not promise
a fresh driver process or compiler cache.

Start with `full`, then compare the reduced variants. A passing isolated full
shader shifts investigation toward prior compilation or renderer setup; a
failing one reproduces without those conditions. Removed calculations can
also remove dependent code during compiler optimization, so a passing variant
identifies a useful reduction, not a proven driver defect or rendering fix.
The one-neighbor variant retains neighbor discovery and both replay directions.

Use `?diagnostics=bdpt-spatial-after-temporal` to compile production temporal,
then the identical full spatial probe, on the same newly requested device.
Both use capacity 10 and workgroup 1x1. The runner retains both pipelines until
the suite finishes, reports their release count, and stops on the first failure
so a failed temporal prerequisite cannot masquerade as a successful comparison.
No buffers are allocated or GPU commands dispatched. Compare against
`bdpt-spatial-full`; a passing pair leaves earlier initial pipelines and renderer
allocations untested. Browser or driver caches can survive a browser restart,
so a fast pass does not establish fresh backend compilation.

Use `?diagnostics=bdpt-temporal-after-spatial` for the reverse order. It reuses
the exact same two probes, retention policy, and failure handling; only their
order changes. Compare both reports after restarting the browser between runs.
Failure at the second pipeline in both orders is consistent with cumulative
pressure but does not prove it; only one failing order suggests order dependence.
Neither result identifies the driver mechanism, and cache reuse remains possible.

## Inverse preparation and application

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
