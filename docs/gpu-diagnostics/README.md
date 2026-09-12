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
