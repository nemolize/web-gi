# Spatial reuse is bounded in world units

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
the equal-time model of #80 on one machine and read this instead. With the defect
gone the throttle measures what it was built for, and what it returns is on #80.
Issue #90 records the measurements behind all of it — the diagnosis, the in-plane
bound, and the world-unit radius — and the `scale`, `radius` and `samples`
overrides in the [benchmark presets](benchmarking.md#presets-and-query-strings)
are what reproduces them. Doubling the radius from its default
did not move the error, so the default is not a tuned optimum — it is a value the
measurement could not distinguish from a wider one.

The figures here show why Relative L2 needs reading with its
[outlier sensitivity](benchmarking.md#reading-relative-l2) in mind. On the worst
case recorded, one channel at the observed maximum accounted for about 38% of
the whole figure, and mean absolute error moved by a factor of 6 where Relative
L2 moved by a factor of 800. The defect was real; the image was not 800× worse.
