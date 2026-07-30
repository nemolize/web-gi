import { expect, test } from "@playwright/test";

test("renders the control panel and starts (or reports) the WebGPU renderer", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle("web-gi — Real-time GI Cornell Box");
  await expect(page.getByRole("heading", { name: "web-gi" })).toBeVisible();
  await expect(page.getByLabel("Cornell box render")).toBeVisible();

  // WebGPU availability depends on the runner, so accept either outcome: a
  // renderer that has accumulated at least one frame, or an explicit notice.
  const accumulated = page.getByTestId("stat-accumulated");
  const notice = page.getByRole("alert");

  await expect
    .poll(
      async () => {
        if ((await notice.count()) > 0) return "notice";
        const text = await accumulated.textContent();
        return Number(text ?? "0") > 0 ? "rendering" : "pending";
      },
      { timeout: 20_000 },
    )
    .not.toBe("pending");
});

test("exposes the ReSTIR stages as independent toggles", async ({ page }) => {
  await page.goto("/");

  const spatialReuse = page
    .getByRole("region", { name: "Indirect light (ReSTIR GI)" })
    .getByLabel("Spatial reuse");

  await expect(page.getByRole("radio", { name: "ReSTIR" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(spatialReuse).toBeEnabled();

  // Reference path tracing bypasses resampling entirely.
  await page.getByRole("radio", { name: "Reference PT" }).click();
  await expect(
    page.getByRole("radio", { name: "Reference PT" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(spatialReuse).toBeDisabled();

  await page.getByRole("radio", { name: "ReSTIR" }).click();
  await expect(spatialReuse).toBeEnabled();
});
