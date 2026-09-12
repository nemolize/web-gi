import { expect, test } from "@playwright/test";

test("staged diagnostics complete three large frames in GPU stage order", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/?diagnostics=bdpt-stages");
  test.skip(
    !(await page.evaluate(async () =>
      Boolean(await navigator.gpu?.requestAdapter()),
    )),
    "WebGPU unavailable",
  );
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(/DONE\./, {
    timeout: 120_000,
  });
  const report = await page.getByLabel("Diagnostic report").inputValue();
  expect(report).not.toContain("FAIL");
  expect(report.match(/finite=true positive=/g)).toHaveLength(9);
  const events = [
    ...report.matchAll(/\] (SUBMIT|COMPLETE) frame (\d) ([\w-]+)/g),
  ].map((m) => m.slice(1));
  const stages = [
    "bdpt-initial-camera",
    "bdpt-initial-light",
    "bdpt-initial-gather",
    "bdpt-caustic-reproject",
    "bdpt-temporal",
    "bdpt-spatial",
    "bdpt-resolve",
    "readback",
  ];
  expect(events).toEqual(
    [0, 1, 2].flatMap((frame) =>
      stages.flatMap((stage) => [
        ["SUBMIT", String(frame), stage],
        ["COMPLETE", String(frame), stage],
      ]),
    ),
  );
});

test("staged diagnostics stop before submitting another stage after Stop", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!globalThis.GPUQueue) return;
    const submit = GPUQueue.prototype.submit;
    window.__stageSubmits = 0;
    GPUQueue.prototype.submit = function (...args) {
      window.__stageSubmits++;
      return submit.apply(this, args);
    };
    const done = GPUQueue.prototype.onSubmittedWorkDone;
    GPUQueue.prototype.onSubmittedWorkDone = async function () {
      await done.call(this);
      await new Promise((resolve) => {
        window.__releaseStage = resolve;
      });
    };
  });
  await page.goto("/?diagnostics=bdpt-stages");
  test.skip(
    !(await page.evaluate(async () =>
      Boolean(await navigator.gpu?.requestAdapter()),
    )),
    "WebGPU unavailable",
  );
  await page
    .getByRole("button", { name: "Run diagnostics", exact: true })
    .click();
  await page.waitForFunction(
    () => window.__releaseStage,
    {},
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByLabel("Diagnostic report")).toHaveValue(/Stopped\./);
  await page.evaluate(() => window.__releaseStage());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__stageSubmits)).toBe(1);
  const report = await page.getByLabel("Diagnostic report").inputValue();
  expect(report).not.toContain("SUBMIT frame 0 bdpt-initial-light");
});
