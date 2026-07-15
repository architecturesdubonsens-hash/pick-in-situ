import { test, expect } from "@playwright/test";
import path from "path";

const EMAIL = process.env.TEST_EMAIL ?? "architecturesdubonsens@gmail.com";
const PASSWORD = process.env.TEST_PASSWORD ?? "";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("/", { timeout: 10000 });
}

test.describe("Upload", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/upload");
  });

  test("affiche la zone de dépôt GLB", async ({ page }) => {
    await expect(page.getByText(/déposez.*glb/i)).toBeVisible();
  });

  test("bouton Importer désactivé sans fichier", async ({ page }) => {
    const btn = page.getByRole("button", { name: /importer/i });
    await expect(btn).toBeDisabled();
  });

  test("affiche erreur si fichier non-GLB déposé", async ({ page }) => {
    const dropzone = page.locator("div.cursor-pointer").first();
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      const f = new File(["test"], "test.pdf", { type: "application/pdf" });
      dt.items.add(f);
      return dt;
    });
    await dropzone.dispatchEvent("drop", { dataTransfer });
    await expect(page.getByText(/non supporté/i)).toBeVisible();
  });
});
