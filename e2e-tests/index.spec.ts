import { expect, test } from "@playwright/test";

test("should load the counter demo page", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Web App Template");

  await expect(
    page.getByRole("heading", { name: "Counter Demo" }),
  ).toBeVisible();

  const decrementButton = page.getByRole("button", {
    name: "Decrement count",
  });
  const incrementButton = page.getByRole("button", {
    name: "Increment count",
  });

  await expect(decrementButton).toBeVisible();
  await expect(incrementButton).toBeVisible();

  const count = page.getByRole("status", { name: "Current count" });
  await expect(count).toHaveText("0");
  await incrementButton.click();
  await expect(count).toHaveText("1");
  await decrementButton.click();
  await expect(count).toHaveText("0");
});
