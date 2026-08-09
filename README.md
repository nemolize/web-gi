# web-gi

Real-time global illumination in the browser, built on WebGPU compute shaders
and staged in a set of switchable rooms — the Cornell box among them. Direct
and indirect lighting are both resolved with **ReSTIR** (Reservoir-based
Spatio-Temporal Importance Resampling), and a brute-force path tracer is
available side by side as the ground-truth reference.

Requires a browser with WebGPU (recent Chrome, Edge, or Safari). The page
reports the reason if the API or an adapter is unavailable.

## What it does

Every surface in the scene is Lambertian, so all light transport is diffuse
interreflection — colour bleeding from the coloured walls, soft shadows from
the area lights, and multi-bounce indirect light are the whole point of the
image.

- **ReSTIR DI** — per pixel, `M` light samples are drawn and resampled with RIS,
  then combined with the reprojected reservoir from the previous frame and with
  reservoirs from neighbouring pixels. Visibility is excluded from the RIS
  target function and applied once, on the surviving sample, at shading time.
- **ReSTIR GI** — one indirect bounce per pixel produces a _sample point_
  carrying the radiance it reflects towards the visible point; that sample is
  reused temporally and spatially through the reconnection Jacobian, with a
  visibility ray guarding against light leaking between reused pixels.
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
exposure, and switches between five scenes staged in the same unit-cube room:

| Scene           | What it is for                                                                            |
| --------------- | ----------------------------------------------------------------------------------------- |
| **Cornell box** | The classic single ceiling emitter and two blocks                                         |
| **30 lights**   | A grid of tinted emitters, where DI resampling has more to work with                      |
| **Two rooms**   | A partition with one doorway: the near half is lit only through the opening and by bounce |
| **Cove light**  | An upward-facing emitter behind a lip, so the whole image is one bounce off the ceiling   |
| **Pillars**     | Nine pillars under a broad emitter — overlapping penumbrae and contact regions            |

## Pipeline

One frame, in dispatch order (`src/gi/renderer.ts`):

| Pass                                  | File                             | Output                                   |
| ------------------------------------- | -------------------------------- | ---------------------------------------- |
| G-buffer                              | `shaders/gbuffer.wgsl`           | world position, normal, albedo, emission |
| DI candidates + temporal reuse        | `shaders/restir-di.wgsl`         | DI reservoir                             |
| DI spatial reuse                      | `shaders/restir-di-spatial.wgsl` | DI reservoir                             |
| GI sample generation + temporal reuse | `shaders/restir-gi.wgsl`         | GI reservoir                             |
| GI spatial reuse                      | `shaders/restir-gi-spatial.wgsl` | GI reservoir                             |
| Shading                               | `shaders/shade.wgsl`             | albedo-demodulated illumination          |
| Temporal accumulation                 | `shaders/denoise-temporal.wgsl`  | accumulated illumination                 |
| À-trous filter (×3)                   | `shaders/denoise-atrous.wgsl`    | filtered illumination                    |
| Resolve                               | `shaders/present.wgsl`           | tone-mapped frame                        |

`shaders/common.wgsl` holds the data layouts, RNG, sampling and reservoir
helpers; `shaders/scene.wgsl` holds the bindings, ray tracing and light
sampling. Both are prepended to every compute shader, so group 0 is identical
across passes and one explicit bind group layout is reused.

Because the scene is entirely Lambertian, accumulated irradiance does not
depend on the eye: ReSTIR keeps its history across camera motion and only drops
it on disocclusion. The reference path tracer averages full radiance per pixel,
so it does restart when the camera moves.

The scene is a small set of parallelograms with perpendicular edges, which lets
the shader invert the barycentric solve with two dot products and skips the need
for any acceleration structure. It also stands in for one: the room is the
convex hull of everything in it, so a shadow ray — always a segment between two
points on its interior surfaces — can never reach a wall. `buildScene` sorts the
walls last and occlusion queries stop before them. Adding geometry outside the
room, or making the room concave, breaks that and is what
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

Only diffuse BRDFs are implemented. Adding specular surfaces would need
reconnection to be skipped at near-delta vertices.

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
