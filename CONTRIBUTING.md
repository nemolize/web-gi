# Contributing

Run `pnpm run lint`, `pnpm run test`, and `pnpm run build` before submitting a PR.

## BDPT verification

The hosted CI runner has no hardware WebGPU adapter. GPU-dependent E2Es skip
when no adapter is available, and several BDPT harnesses also skip against the
production preview because they import development modules. A green CI E2E job
therefore does not establish BDPT rendering correctness. See [#201](https://github.com/nemolize/web-gi/issues/201).

Changes to BDPT shaders, pass recording, resources, or renderer integration
require a local run on a real GPU before merge:

```bash
CI= E2E_PREVIEW=0 E2E_WEBGPU=1 pnpm run test:e2e --workers=1 'bdpt-.*\.spec\.js' gpu-diagnostics.spec.js
```

`E2E_WEBGPU=1` enables Chromium's unsafe WebGPU flag and selects Metal on macOS.
It does not supply a GPU. Use a hardware adapter with `timestamp-query` support
to also run the spatial-profile tests; SwiftShader is not a substitute for this
check. `CI=` and `E2E_PREVIEW=0` select the development server so the module-based
harnesses execute. Set
`PLAYWRIGHT_PORT` to an unused port if the default is occupied.

Inspect the test summary: all selected tests must pass with **zero skipped**.
An unavailable adapter, timestamp feature, or development-module skip means
verification is incomplete, even if Playwright exits successfully. Record the command, GPU,
browser version, and pass/skip counts in the PR. Use `--headed` if needed to
diagnose local browser or driver problems.

GPU-independent regression tests in `src/gi/bdpt/runtime.test.js` exercise the
real runtime and pass-recording code using a mock device. They check dynamic
region bindings on all seven passes and checkpoint regions, dispatch sizes,
and pixel coverage for tiled recording. They run in the normal unit-test CI
job, but cannot check WGSL compilation, GPU validation, or rendered output.
