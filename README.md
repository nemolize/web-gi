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
never for recording a verdict: at two repeats a unanimous case is one in two by
chance, so the repeat-to-repeat spread a low-resolution ReSTIR run turns out to
need cannot be separated from noise, and the oracle is below the 512 frames that
already flipped a Relative L2 winner once. Numbers quoted in this README come
from `preset=matrix`.

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
unexplained. `scale` is also the throttle #80 asks for — the equal-time
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
opposite sweeps. It is also what a hybrid would have to exploit, and the
recorded desktop run offered no such split — its primary-metric winners did not
divide along scene lines, so there was no scene-dependent pattern to build one
around (#43).

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
The other four are diagnostic — they say _how_ the images differ, and they
routinely run opposite to the primary one on the same case.

The completion line shows the relative-L2 split by scene along with how many of
those wins were unanimous, without opening the JSON.

The automatic 1,024-frame reference is the mobile default: it preserved the
decisions a 2,048-frame sweep made, while a 512-frame run changed one Relative L2
winner. Budget the single-pass duration times the repeat count. Higher-confidence
one-off validation can still use the development controls to save a longer
reference, with the actual frame count retained in the report.

**Which renderer wins depends on the device, so any claim about it has to name
one.** Recorded runs put ReSTIR ahead on Relative L2 on a phone and Denoised PT
ahead on a desktop, which is what an equal-time model predicts: the faster the
machine, the further path tracing's larger frame count carries against what
resampling buys per frame. The crossover between them is not measured (#80), and
a run's own report is the place to read its figures rather than this page.

### Spatial reuse is bounded in world units

The reuse radius and the test that accepts a neighbour have to be in the same
unit. They were not: `spatialRadius` was a pixel count while the acceptance test
was a world distance, so their ratio depended on the render resolution and a
radius tuned at one resolution meant something else at another.

The acceptance test also measured only the offset's component along the normal:

```wgsl
abs(dot(neighborPosition - x, n)) > PLANE_TOLERANCE
```

For two points on one flat surface that component is identically zero at any
separation, so along a surface it rejected nothing. The room is a unit cube whose
walls, floor and ceiling dominate it, which left the pixel radius as the only
bound on reuse distance — and at a low enough resolution that bound reaches
across the room. Both spatial passes now also bound the offset **in the surface
plane**.

The radius is a world distance too, converted to a pixel radius per pixel against
that surface's own depth:

```wgsl
worldPerPixel = depth * 2 * camTanHalfFov / resolution.y
pixelRadius   = clamp(spatialRadius / worldPerPixel, 1, 64)
```

This is not the same as scaling a pixel radius with resolution. That keeps a
pixel count and rescales it, leaving a quantity that still means a different reuse
distance at different depths within one frame. Stating the radius in world units
puts it in the same unit as the acceptance test, so the guard **is** the radius —
there is no separate tolerance constant, and `radius` moves both. It also stops
the guard from being reached by rejection: at high resolution a pixel radius drew
most of its taps past the tolerance and the guard discarded them, spending the
neighbour budget to find nothing.

The pixel conversion is clamped to 1–64, since it diverges as a surface nears the
eye, and a sub-pixel offset would truncate back onto the centre pixel — a self-tap
passes every guard, so the pass would merge the centre reservoir into itself once
per neighbour slot.

The DI pass is the more exposed of the two: it has no visibility test and no
Jacobian gate, accepting a neighbour on `diTargetPdf` alone, and `diTargetPdf`
excludes visibility by design (it is deferred to `shaders/shade.wgsl`). A sample
resampled from a lit neighbour can therefore land on a shadowed pixel and still
take a large reservoir weight. The GI pass has a Jacobian and one group
visibility ray, so it degrades more gracefully. The path tracer dispatches
neither spatial pass, so it is structurally unaffected.

The defect surfaced through the `scale` throttle, which had been added to test
the equal-time model of #80 on one machine; it dominated that reading rather than
the crossover, so throttling one device still does not measure the crossover.
Issue #90 records the measurements behind all of it — the diagnosis, the in-plane
bound, and the world-unit radius — and the `scale`, `radius` and `samples`
overrides above are what reproduces them. Doubling the radius from its default
did not move the error, so the default is not a tuned optimum — it is a value the
measurement could not distinguish from a wider one.

One property of the primary metric is worth knowing before reading any figure it
produces: Relative L2 divides by `b² + 1e-3` (`src/gi/compare.ts`), so a stray
bright sample where the reference is black contributes enormously. On the worst
case recorded there, one channel at the observed maximum accounted for about 38%
of the whole figure, and mean absolute error moved by a factor of 6 where
Relative L2 moved by a factor of 800. The defect was real; the image was not 800×
worse.

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

A `compareLinear` sweep across both scenes, three camera positions, and every
combination of spatial-neighbour count and bounce depth put the residual well
under a percent of luminance, in either direction — it is not consistently dark.
Run one to see the figures for a given build rather than trusting this sentence.

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
