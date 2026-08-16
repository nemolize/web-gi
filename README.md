# web-gi

Real-time global illumination in the browser, built on WebGPU compute shaders
and staged in a set of switchable rooms — the Cornell box among them. Direct
and indirect lighting are both resolved with **ReSTIR** (Reservoir-based
Spatio-Temporal Importance Resampling), and a brute-force path tracer is
available side by side as the ground-truth reference.

Requires a browser with WebGPU (recent Chrome, Edge, or Safari). The page
reports the reason if the API or an adapter is unavailable.

## What it does

The rooms primarily use Lambertian surfaces, so diffuse interreflection —
colour bleeding, soft shadows, and multi-bounce indirect light — remains the
core of the image. The glass scene adds an analytic sphere and two clear cuboid
dielectrics with Fresnel reflection, refraction, total internal reflection, and
subtle transmission tints.

- **ReSTIR DI** — per pixel, `M` light samples are drawn and resampled with RIS,
  then combined with the reprojected reservoir from the previous frame and with
  reservoirs from neighbouring pixels. Visibility is excluded from the RIS
  target function and applied once, on the surviving sample, at shading time.
- **ReSTIR GI** — one indirect bounce per pixel produces a _sample point_
  carrying the radiance it reflects towards the visible point; that sample is
  reused temporally and spatially through the reconnection Jacobian, with a
  visibility ray guarding against light leaking between reused pixels.
- **Denoised path tracer** — one path sample per visible surface is accumulated
  temporally and filtered by the same à-trous chain as ReSTIR. It is the
  equal-time comparison path: cheaper frames buy more independent samples,
  while the filter sees the same albedo-demodulated illumination representation.
- **Reference path tracer** — same scene, same light transport, no resampling
  and no denoiser. One path per pixel per frame, progressively averaged. Use it
  to check what ReSTIR is converging towards.

Each stage — DI/GI, temporal reuse, spatial reuse, the à-trous filter — is an
independent toggle, so the contribution of every part of the algorithm is
visible on its own.

## Controls

Drag to orbit, scroll to dolly. The room is a closed box; primary rays cull
back-facing surfaces so the near wall becomes a cutaway and the interior stays
visible from any angle.

The panel exposes the RIS candidate count, spatial neighbour count and radius,
GI bounce depth, the temporal accumulation window, resolution scale, and
exposure, and switches between six scenes staged in the same unit-cube room:

| Scene                      | What it is for                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| **Cornell box**            | The classic single ceiling emitter and two blocks                                             |
| **Glass sphere & cuboids** | Three clear analytic dielectrics with reflected and refracted room detail                     |
| **30 lights**              | A grid of tinted emitters, where DI resampling has more to work with                          |
| **Two rooms**              | A partition with one doorway: the near half is lit only through the opening and by bounce     |
| **Cove light**             | An upward-facing emitter behind a lip: the room below it is lit by the bounce off the ceiling |
| **Pillars**                | Nine pillars under a broad emitter — overlapping penumbrae and contact regions                |

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
never for recording a verdict: two repeats cannot show the repeat-to-repeat
spread that a low-resolution ReSTIR run turns out to need, and the oracle is
below the 512 frames that already flipped a Relative L2 winner once. Numbers
quoted in this README come from `preset=matrix`.

`scale` throttles the matrix to a lower resolution, which raises both renderers'
frame rates without touching anything else in the preset. It accepts `0.25`,
`0.3`, `0.35`, `0.4`, `0.5`, `0.6`, `0.75` (the preset's own scale) and `1`;
anything else is ignored and the run proceeds at `0.75`. The value it ran at is
recorded in the report's `url`, so two runs at different scales stay
distinguishable afterwards. `radius` overrides the spatial reuse radius the same
way, from `2` to `64`; it exists to test whether that radius explains the
low-resolution ReSTIR error recorded below (#90). This is the throttle #80 asks for — the equal-time
verdict is a function of achievable frame rate, so lowering the resolution on one
machine tests the model that predicts the crossover without needing a second
device. It cannot rule out a device-specific cause on its own.

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
opposite sweeps. It is also what a hybrid would have to exploit: on the desktop
run below the primary metric's winners do not divide along scene lines, so that
run offers no scene-dependent pattern to build one around (#43).

### How a verdict is decided

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
The other four are diagnostic — they say _how_ the images differ and can run
opposite to the primary one, as the recorded runs below do.

The completion line shows the relative-L2 split by scene along with how many of
those wins were unanimous, without opening the JSON.

The automatic 1,024-frame reference is the mobile default: at 691×1,445, the
target-device matrix completed one pass of its measured phases in 188 seconds
and preserved the 2,048-frame sweep's decisions. ReSTIR had lower Relative L2 in
all six cases; Denoised PT had lower mean absolute error and fewer outliers in
all six, plus lower absolute luminance error in four. A 512-frame run was
rejected after it changed one Relative L2 winner. Those figures are aggregates
from a single unrepeated pass, recorded before the summary existed, and they were
read off each renderer's own errors rather than the paired difference — so they
say neither how the six cases split by scene nor which verdicts every repeat
agreed on. A fresh matrix run reports both directly. Budget the single-pass
duration times the repeat count. Higher-confidence one-off validation can still
use the development controls to save a longer reference, with the actual frame
count retained in the report.

A desktop run points the other way. On an Apple silicon laptop in Chrome 150 at
1,128×885, four repeats of the six cases put Denoised PT lower on Relative L2 in
all six, every one of them unanimous, by paired median differences of 2.9%,
12.9%, 16.4%, 19.2%, 28.7% and 30.6%. Mean absolute and outliers agree in all
six; max absolute agrees in five with one exact tie, none unanimous. Path
tracing got almost exactly twice the frames in the same five seconds (1.93× to
2.14×): at this speed the extra samples outweigh what resampling buys. The frame
ratio does not explain the spread, though — it is near-constant across the six
cases while the margins run from 2.9% to 30.6%, so resampling is buying
something per frame, just not enough to close the gap.

Luminance is the one metric that does not follow, and it splits 3:3 with no case
unanimous. Its direction is nonetheless perfectly consistent — ReSTIR came out
brighter than the oracle in all 24 runs and Denoised PT darker in all 24 — so on
this device the bias is consistent in sign and buried in noise in magnitude. The
earlier unrepeated desktop pass read this as a clean ReSTIR win; four repeats do
not support that.

The two devices disagree, and consistently so under an equal-time model: the
faster the machine, the more path tracing's larger frame count outweighs
resampling. The crossover point is still not measured, so any claim about which
renderer wins has to name the device.

Two caveats on the run itself. It filtered with `fallback`, while the earlier
desktop pass ran before tiling became opt-in and used `tiled-16` — so the two
desktop readings differ in filter as well as in decision rule, and are not a
like-for-like pair. And oracle generation slowed by 12–19% from the first sweep
to the last (3,267→3,890 ms on `classic`, 5,428→6,077 ms on `manyLights`), so the
machine was heating over the session; pairing absorbs that for the verdicts —
both renderers share one oracle per repeat — but the absolute frame counts are
lower late in the run than early.

### Throttling one device does not measure the crossover

The `scale` throttle was added to test the equal-time model on a single machine
(#80): if the verdict follows achievable frame rate, lowering the resolution
should move it. A Galaxy-class Android device in Chrome 140 ran the matrix twice,
identical but for the scale — 691×1445 then 270×564, four repeats each,
`fallback` in both.

The verdict did move, from ReSTIR winning Relative L2 in four of six cases to
Denoised PT winning all six, every one unanimous. But it moved for the wrong
reason, so it does not locate a crossover. Path tracing's frame advantage
**shrank** as the resolution fell — the median PT/ReSTIR ratio went from 2.20 to
1.67 — while the verdict swung towards PT. Both renderers got roughly four times
the frames (ReSTIR 54→256 per five seconds, PT 118→437), so it is not a
convergence-time effect either. Under the equal-time model a smaller frame
advantage should favour ReSTIR; it did the opposite.

What actually changed is ReSTIR's error at low resolution:
`manyLights/right-high` went from 0.045 to 35.97 (one repeat reached 102.7),
`classic/right-high` from 0.015 to 0.347. Denoised PT barely moved on any case
and stayed within 1.02× across repeats, while ReSTIR's spread reached 7.2×.

Two separate things produce that number, and neither is the device speed the
issue set out to measure:

- **ReSTIR's spatial reuse degrades as pixels cover more of the scene.**
  `spatialRadius` is a pixel count (`src/gi/renderer.ts`) but the guard that
  accepts a neighbour is a world-space plane distance
  (`src/gi/shaders/restir-di-spatial.wgsl`), and that guard measures only the
  component along the normal — so for two points on one flat surface it is zero
  at any separation. On the unit-cube room the 24-pixel radius sits inside the
  tolerance at 691×1445 and crosses it at 270×564. The path tracer never
  dispatches either spatial pass, which is why it is unaffected.
- **Relative L2 amplifies a handful of pixels.** It divides by `b² + 1e-3`
  (`src/gi/compare.ts`), so a stray bright sample where the reference is black
  contributes enormously. One channel at the observed maximum accounts for about
  38% of the whole `manyLights/right-high` figure — a few pixels, not an
  image-wide collapse. Mean absolute rose 6.3× on that case where Relative L2
  rose 801×.

Narrowing the radius to its world-space equivalent (`radius=8` at `scale=0.25`,
matching what 24 pixels spanned at the higher resolution) confirms the first
mechanism on four of the six cases, which return to within 1.4× of their
baseline error. It does not explain the other two: `manyLights/right-high`
improves twenty-fold but remains at 1.52, and `classic/right-high` reads 9.19,
worse than the 0.347 it showed at the wider radius. Both are the grazing-angle
camera, and both swing wildly between repeats — 11× and 188× — against 1.1–3.7×
on the four that recovered. At four repeats that dispersion is wide enough that
the direction of the `classic/right-high` change is not established; what the
run does establish is that something beyond the reuse radius affects the
grazing-angle cases.

So the throttle reads as a ReSTIR defect surfacing at low resolution rather than
as the equal-time crossover, and the crossover device speed remains unmeasured.
The `right-high` camera is the only one in the matrix that sees the floor and
ceiling at a grazing angle, and `manyLights` puts 30 small emitters on a pitch
comparable to the widened reuse radius, which is why those two cases are worst
hit.

## Pipeline

One frame, in dispatch order (`src/gi/renderer.ts`):

| Pass                                  | File                             | Output                          |
| ------------------------------------- | -------------------------------- | ------------------------------- |
| G-buffer                              | `shaders/gbuffer.wgsl`           | depth, normal, albedo, emission |
| DI candidates + temporal reuse        | `shaders/restir-di.wgsl`         | DI reservoir                    |
| DI spatial reuse                      | `shaders/restir-di-spatial.wgsl` | DI reservoir                    |
| GI sample generation + temporal reuse | `shaders/restir-gi.wgsl`         | GI reservoir                    |
| GI spatial reuse                      | `shaders/restir-gi-spatial.wgsl` | GI reservoir                    |
| Shading                               | `shaders/shade.wgsl`             | albedo-demodulated illumination |
| 1 spp path tracing (alternative)      | `shaders/path-trace.wgsl`        | albedo-demodulated illumination |
| Temporal accumulation                 | `shaders/denoise-temporal.wgsl`  | accumulated illumination        |
| À-trous filter (×3)                   | `shaders/denoise-atrous.wgsl`    | filtered illumination           |
| Resolve                               | `shaders/present.wgsl`           | tone-mapped frame               |

`shaders/common.wgsl` holds the data layouts, RNG, sampling and reservoir
helpers; `shaders/scene.wgsl` holds the bindings, ray tracing and light
sampling. Both are prepended to every compute shader, so group 0 is identical
across passes and one explicit bind group layout is reused.

Diffuse irradiance does not depend on the eye, so ReSTIR and the denoised path
tracer normally keep their history across camera motion and drop it only on
disocclusion. Reference rendering and glass scenes restart accumulation because
their full reflected and refracted radiance is view-dependent.

The scene is a small set of parallelograms with perpendicular edges plus
optional analytic glass spheres and boxes. Quad intersections invert the
barycentric solve with two dot products and skip the need for any acceleration
structure. The closed room provides another shortcut: it is the convex hull of
everything in it, so a shadow ray — always a segment between two points on its
interior surfaces — can never reach a wall. `buildScene` sorts the walls last
and occlusion queries stop before them. Adding geometry outside the room, or
making the room concave, breaks that and is what
`shadow-ray-occluders.test.ts` guards. `src/gi/scene.ts` builds it and packs it for the
GPU; the unit tests check the packing offsets against the WGSL struct layout and
the camera maths against its shader counterpart.

## Known bias

The reuse passes use the `M`-weighted combination (Bitterli et al. 2020,
Algorithm 4) with the 1/Z correction for spatial reuse, and clamp the temporal
history length. That combination is biased, and the visibility test used to
reject GI candidates is not reflected in the 1/Z normalisation.

A `compareLinear` sweep at 480×450 over three camera positions, the Cornell box
and 30-light scenes, and all combinations of spatial-neighbour counts 0/4/8 and
bounce depths 1/3/6 measured luminance ratios of 0.9947–1.0041 after at least
2,048 reference frames and 1,024 ReSTIR frames. Relative L2 ranged from
0.0014–0.0043 and mean absolute error from 0.0026–0.0085 in linear radiance.
The residual is not consistently dark; its observed luminance shortfall or
excess stayed within 0.53% across this sweep.

ReSTIR reservoirs remain restricted to diffuse vertices. Glass shapes are
evaluated as delta paths in the shading pass and are never stored in a reservoir
for spatial or temporal reconnection.

## Development

The toolchain versions are pinned in `mise.toml` ([mise](https://mise.jdx.dev/)
provisions them with `mise install`).

```bash
pnpm install
pnpm dev          # dev server on http://localhost:5173
pnpm build        # type-check and build
pnpm test         # unit tests
pnpm test:e2e     # Playwright end-to-end tests against the dev server
pnpm lint         # eslint, prettier and type-check
pnpm fix          # auto-fixable lint and formatting
```

`E2E_PREVIEW=1 pnpm run test:e2e` builds first and runs the suite against
`vite preview`, which is what CI does — the only way to exercise `wrangler.json`
asset serving and the hashed production bundle locally.

WGSL compile errors are reported to the console with the shader name and
`line:column`; without that they only surface as invalid-pipeline warnings at
dispatch time.

Development builds add `Save ref` and `Compare 5 s` to the stats overlay. Save
a converged `Reference PT`, switch renderers, then compare: the accumulator is
reset, each submitted frame is allowed to finish, and the result is captured
after at least five seconds of completed rendering work. The linear-radiance
error is shown without copying the full float image out of the page. The
underlying `window.__gi` hooks remain available for scripted experiments.

## Deployment

Deployment is handled by `.github/workflows/deploy.yml`:

- Push to `main` deploys to production (`wrangler deploy`).
- A manual run from `main` redeploys production; manual runs from other refs upload a preview version instead.
- Pull requests upload a preview version (`wrangler versions upload`); the preview URL is posted as a sticky PR comment.
- Fork pull requests and Dependabot pull requests are skipped — neither can read the workflow's Cloudflare token.

The Worker configuration lives in `wrangler.json`. The build is driven by
`@cloudflare/vite-plugin`, which generates the deployable config under `dist/`
during `pnpm build`.

## References

- Bitterli et al., _Spatiotemporal reservoir resampling for real-time ray tracing with dynamic direct lighting_, SIGGRAPH 2020
- Ouyang et al., _ReSTIR GI: Path Resampling for Real-Time Path Tracing_, HPG 2021
- Schied et al., _Spatiotemporal Variance-Guided Filtering_, HPG 2017

## License

MIT
