# Benchmark methodology

How `web-gi` measures ReSTIR against a denoised path tracer, and how a verdict
is decided. All of it runs in the browser from a query string — no build step
and no local checkout required.

Numbers quoted anywhere in the project come from `preset=matrix`.

## Presets and query strings

Repeatable benchmark runs can start from short query strings:

- `?preset=heavy&mode=restir&measure=auto`
- `?preset=heavy&mode=path-traced&measure=auto`

`preset=heavy` selects 30 lights, 32 DI candidates, eight spatial neighbours,
six bounces, and 75% resolution. `measure=auto` starts the standard three-by-five
second capture as soon as the renderer is ready; the completed report remains
available through `Copy result`.

Equal-time linear-radiance comparisons use similarly short URLs:

- `?preset=matrix`
- `?preset=matrix&scale=0.4`
- `?preset=probe`
- `?preset=heavy&compare=restir`
- `?preset=heavy&compare=path-traced`

The matrix preset runs the Cornell box and 30-light scene from the front, left,
and right-high views. It builds one exact 1,024-frame, GPU-completion-paced
`Reference PT` oracle per view and compares both ReSTIR and Denoised PT against
that shared image for five seconds each. The whole six-case sweep repeats — four
times by default — with repeats outermost, so a case's measurements are spread
across the session rather than taken back to back in one thermal state. The
individual URLs run the same process for one renderer at the default view.
Reports include the camera basis, settings, a-trous variant, frame counts, actual
durations, and linear-radiance error metrics, and remain available through
`Copy result`. Keep the page visible and unchanged while the several-minute
matrix is running.

`preset=probe` runs the same six cases and the same pairing on a tenth of the
wall clock — around 30 seconds against roughly five and a half minutes — by
taking two repeats instead of four, a 256-frame oracle instead of 1,024, and
750 ms per renderer instead of five seconds. It is for iterating on a change,
never for recording a verdict: at two repeats a unanimous case is one in two by
chance, so the repeat-to-repeat spread a low-resolution ReSTIR run turns out to
need cannot be separated from noise, and the oracle is below the 512 frames that
already flipped a Relative L2 winner once.

`scale` throttles the matrix to a lower resolution, which raises both renderers'
frame rates without touching anything else in the preset. It accepts `0.25`,
`0.3`, `0.35`, `0.4`, `0.5`, `0.6`, `0.75` (the preset's own scale) and `1`;
anything else is ignored and the run proceeds at `0.75`. The value it ran at is
recorded in the report's `url`, so two runs at different scales stay
distinguishable afterwards. `radius` overrides the spatial reuse radius the same
way, accepting `0.005`, `0.01`, `0.02`, `0.03`, `0.04` (the preset's own radius),
`0.06`, `0.08`, `0.12` and `0.16`. Those are world units, not pixels, since #90,
and they move the neighbour-rejection distance with them — the guard is the
radius. `samples` overrides the number
of neighbours each spatial pass visits, accepting `0`, `1`, `2`, `4` and `8` (the
preset's own count). `0` disables spatial reuse outright — both passes degenerate
to a 1/Z pass-through — which separates the reuse radius from temporal
reprojection as the cause of the grazing-angle cases the `radius` run left
unexplained. `tangent` overrides how far along a surface an a-trous tap still
counts, accepting `0.02`, `0.04`, `0.08` (the default), `0.16`, `0.32` and
`1000`; the last is wide enough to restore the unbounded reach the term replaced.
`scale` is also the throttle #80 asks for, which tests on one
machine whether the verdict follows achievable frame rate. It does not: the
throttled run has the smaller frame advantage and still moves the verdict towards
path tracing.

Two things vary across repeats so the schedule does not bake in what it is trying
to measure. Run order alternates on the camera index plus the repeat number,
which balances each scene's split of the two orders at an even repeat count —
hence the even default. And each repeat rotates the case order by one, so a scene
does not sit at the same point of every sweep and track elapsed time along with
it.

A matrix report also carries a derived `summary`: the winner of each metric on
each case, tallied both overall and **per scene**. Luminance is scored as
`|ratio - 1|`, since a ratio of 0.9 and one of 1.1 are equally biased.

The per-scene split is the part worth reading — an even overall tally can be two
opposite sweeps. It is also what a hybrid would have to exploit, and the
recorded desktop run offered no such split — its primary-metric winners did not
divide along scene lines, so there was no scene-dependent pattern to build one
around (#43).

## How a verdict is decided

Within one repeat, both renderers meet the _same_ oracle at the _same_ point in
the session, which makes their two errors a matched pair. Each repeat therefore
contributes one symmetric relative difference,

```
2 × (PT_error − ReSTIR_error) / (PT_error + ReSTIR_error)
```

positive where ReSTIR is lower, and the verdict is the median of those. The two
renderers run one after the other rather than simultaneously, so the pairing
cancels what they share — the same oracle, the same repeat block, the same
machine state at that point in the sweep — not order effects or drift within the
pair. Comparing the two renderers' medians separately cancels none of it: those
medians can come from different repeats, so `ReSTIR [1, 100, 101]` against
`PT [2, 3, 200]` makes the median say PT while ReSTIR is in fact lower in two of
the three head-to-heads.

A median difference under **1%** on the primary metric is reported as a tie. That
is a provisional tolerance on a continuous error measure, not a calibrated
perceptual bound, and it is deliberately not applied to the diagnostic metrics —
on a count like `outliers`, 0 against 1 is a 200% difference while 100 against
101 is under 1%, so one threshold cannot mean the same thing across all five.

Each verdict also reports whether it is **unanimous** — whether every repeat put
the winner lower. Read it as a direction-consistency diagnostic, not as
significance: `2/2ⁿ` of runs on renderers that do not differ are unanimous by
chance, which at four repeats is one case in eight, so across six cases seeing at
least one is likelier than not (about 55%). A split verdict is genuinely not
established; a unanimous one is a candidate worth repeating at a higher count.

Relative L2 is the **primary** metric and the report marks it as such. The point
is naming it before the run rather than after: with five metrics on offer, a
verdict picked from whichever came out favourably is a verdict about the picking.
The other four are diagnostic — they say _how_ the images differ, and they
routinely run opposite to the primary one on the same case.

The completion line shows the relative-L2 split by scene along with how many of
those wins were unanimous, without opening the JSON.

The automatic 1,024-frame reference is the mobile default: it preserved the
decisions a 2,048-frame sweep made, while a 512-frame run changed one Relative L2
winner. Budget the single-pass duration times the repeat count. Higher-confidence
one-off validation can still use the development controls to save a longer
reference, with the actual frame count retained in the report.

**Which renderer wins depends on the condition, so any claim about it has to
name one.** Recorded runs put ReSTIR ahead on Relative L2 on a phone at full
resolution and Denoised PT ahead on a desktop, and also ahead on that same phone
once throttled. What separates them is open (#80): the equal-time reading — the
faster the machine, the further path tracing's larger frame count carries —
predicts the throttled phone should favour ReSTIR, and it does not. A run's own
report is the place to read its figures rather than this page.

## Manual comparison in development builds

Development builds add `Save ref` and `Compare 5 s` to the stats overlay. Save
a converged `Reference PT`, switch renderers, then compare: the accumulator is
reset, each submitted frame is allowed to finish, and the result is captured
after at least five seconds of completed rendering work. The linear-radiance
error is shown without copying the full float image out of the page. The
underlying `window.__gi` hooks remain available for scripted experiments.
