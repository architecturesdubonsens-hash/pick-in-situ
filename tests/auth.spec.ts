import { test, expect } from "@playwright/test";

const EMAIL = process.env.TEST_EMAIL ?? "architecturesdubonsens@gmail.com";
const PASSWORD = process.env.TEST_PASSWORD ?? "";

test.describe("Authentification", () => {
  test("redirige /login si non connecté", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("connexion avec credentials valides", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL("/", { timeout: 10000 });
  });

  test("erreur avec mauvais mot de passe", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', "mauvais_mdp_123");
    await page.click('button[type="submit"]');
    await expect(page.locator("p.text-red-600")).toBeVisible({ timeout: 8000 });
  });
});
