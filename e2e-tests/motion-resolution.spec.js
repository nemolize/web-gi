import { expect, test } from "@playwright/test";

test("camera motion reuses targets and restores full-resolution output", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    globalThis.motionAllocations = 0;
    const prototype = globalThis.GPUDevice?.prototype;
    if (!prototype) return;
    for (const name of ["createBuffer", "createTexture"]) {
      const original = prototype[name];
      prototype[name] = function (...args) {
        globalThis.motionAllocations++;
        return Reflect.apply(original, this, args);
      };
    }
  });
  await page.goto("/");
  await expect
    .poll(
      async () => {
        const alerts = await page.getByRole("alert").allTextContents();
        if (alerts.some((text) => text.includes("WebGPU is not available")))
          return "unavailable";
        return Number(
          await page.getByTestId("stat-accumulated").textContent(),
        ) > 30
          ? "ready"
          : "pending";
      },
      { timeout: 20_000 },
    )
    .not.toBe("pending");
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "WebGPU is not available" });
  if (await notice.count()) {
    await expect(notice).toContainText(
      /WebGPU is not available|No WebGPU adapter/,
    );
    test.skip(true, "requires a WebGPU adapter");
  }

  for (const mode of ["ReSTIR", "Denoised PT", "Reference PT"]) {
    await page.getByRole("radio", { name: mode, exact: true }).click();
    await expect
      .poll(async () =>
        Number(await page.getByTestId("stat-accumulated").textContent()),
      )
      .toBeGreaterThan(20);
    const result = await page.evaluate(async () => {
      const canvas = document.querySelector("canvas");
      const full = [canvas.width, canvas.height];
      const allocations = globalThis.motionAllocations;
      const frame = () =>
        new Promise((resolve) => requestAnimationFrame(resolve));
      const moving = [];
      for (let i = 0; i < 10; i++) {
        canvas.dispatchEvent(
          new WheelEvent("wheel", { deltaY: 1, cancelable: true }),
        );
        await frame();
        moving.push([canvas.width, canvas.height]);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      await frame();
      const restored = [canvas.width, canvas.height];
      const newAllocations = globalThis.motionAllocations - allocations;
      const image = await globalThis.__gi.capture();
      return {
        full,
        moving,
        restored,
        newAllocations,
        captured: [image.width, image.height],
        finite: image.data.every(Number.isFinite),
        lit: image.data.some((value, index) => index % 4 !== 3 && value > 0),
      };
    });
    const movingSize =
      mode === "Reference PT"
        ? result.full
        : result.full.map((extent) => Math.max(1, Math.floor(extent / 2)));
    expect(result.moving).toContainEqual(movingSize);
    expect(result.restored).toEqual(result.full);
    expect(result.captured).toEqual(result.full);
    expect(result.newAllocations).toBe(0);
    expect(result.finite).toBe(true);
    expect(result.lit).toBe(true);
  }
  await page.getByRole("radio", { name: "ReSTIR", exact: true }).click();
  await page.getByLabel("Smooth camera motion").uncheck();
  const fixed = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    const before = [canvas.width, canvas.height];
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { before, after: [canvas.width, canvas.height] };
  });
  expect(fixed.after).toEqual(fixed.before);
  expect(errors).toEqual([]);
});
