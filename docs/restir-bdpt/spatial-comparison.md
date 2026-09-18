# Same-build spatial comparison

Open `/?diagnostics=bdpt-spatial-ab&bdptDispatchPixels=4096` and select **Run
comparison**. Use the default 353 × 738 preset for the Fold 7 comparison and
copy the completed JSON with **Copy report**. Keep the tab visible, the device
orientation unchanged, and other GPU workloads idle. Hiding the tab cancels
the run. Both diagnostic screens request a screen wake lock while running and
release it on completion, stop, or navigation. If unavailable, denied, or revoked
by the browser, the screen shows a manual keep-awake notice; diagnostics can still
run. See the [Screen Wake Lock specification](https://www.w3.org/TR/screen-wake-lock/).
The small preset is a correctness smoke check, not performance evidence
for the Fold workload.

Normal rendering keeps the baseline spatial shader. Only this diagnostic lazily
loads the candidate from rejected PR #214, revision
`0a85a9783db6aa83b9f66c6f04011aa6174889a6`. Its camera, light, gather, reproject,
temporal, resolve, denoising, and presentation passes are shared with the baseline.
Both spatial pipelines compile before sampling on one device, with matching
actual workgroup sizes. A fallback to different workgroup sizes fails the run.

Each of three cycles measures A1 (baseline), B (candidate), then A2 (baseline).
Each phase resets accumulation/history and frame seeds, warms up for five frames,
and captures six GPU-completion-paced frames. These fixed counts are an empirical
mobile test budget; they keep all phases at the same frame indices. They do not
establish thermal steady state. Full-frame light-list atomic insertion can vary
between executions, so the full-frame inputs are not claimed to be bitwise equal.

GPU frame time spans the first pass through presentation, including gaps between
submissions. Spatial time sums only spatial dispatch timestamps. Completion time
also includes CPU encoding, GPU waits, and timestamp readback. All raw samples and
per-pass times are retained. The before/after baseline ratios expose drift; no
winner or significance claim is generated. Six samples per phase are insufficient
for precise tail-latency estimates.

After each cycle, the last frame's uniforms and temporal reservoirs are held
unchanged while spatial runs A1 → B1 → B2 → A2. Output is cleared before every
run. Schema version 2 records baseline/candidate, candidate/repeat, and
baseline/repeat comparisons separately, including changed words and pixels for
each normal/caustic reservoir field. Seeds and flags are decoded as `u32`; other
fields use their WGSL `f32` types. Each field retains at most three changed-value
examples with pixel coordinates, component indices, and raw bits.

Float summaries count NaN and positive/negative infinity on both sides, including
unchanged non-finite values. Absolute and relative error maxima use finite pairs
only; relative error is `abs(a-b) / max(abs(a), abs(b))`, or zero for two zeros.
Signed zero can differ in bits without a numeric difference. Non-finite examples
are JSON strings so copying does not silently turn them into nulls. No numerical
tolerance or image-quality equivalence is inferred from these summaries.

Readback and analysis occur outside timing windows. A mismatch, non-finite float,
or empty output stops further cycles but preserves the complete structured report
with `outcome: "mismatch"`, timings, and field details. A matching run has
`outcome: "matched"`; this checks only sampled equivalence, not general rendering
correctness. GPU errors, missing timestamps, changed dimensions, and cancellation
remain execution failures. Frozen checks retain two CPU snapshots (about 83 MB
at 353 × 738) plus one reusable GPU staging buffer.

Reports include the effective resolution, settings, camera, adapter information
(as exposed by the browser), every BDPT workgroup size, dispatch cap, submission
batch, and candidate revision. Query overrides are preserved. The default dispatch
cap is 4096 pixels; a positive cap and `timestamp-query` support are required.
Renderer creation has a two-minute deadline; the comparison has a ten-minute
deadline after creation. A completed
report is evidence for that device and workload only. Repeat on Fold before
adopting the candidate; remove the rejected shader and this experiment once the
decision is settled.
