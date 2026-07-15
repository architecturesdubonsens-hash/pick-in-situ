import { test, expect } from "@playwright/test";

const EMAIL = process.env.TEST_EMAIL ?? "architecturesdubonsens@gmail.com";
const PASSWORD = process.env.TEST_PASSWORD ?? "";

test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 10000 });
  });

  test("affiche la liste des chantiers", async ({ page }) => {
    await expect(page.getByText("Mes chantiers")).toBeVisible();
  });

  test("lien Importer un scan accessible", async ({ page }) => {
    await page.getByRole("link", { name: /importer|scan/i }).first().click();
    await expect(page).toHaveURL(/\/upload/);
  });
});
