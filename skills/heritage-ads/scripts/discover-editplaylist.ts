import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const email = process.env.SMINFINITY_EMAIL!;
const password = process.env.SMINFINITY_PASSWORD!;
const ERRORS = "/home/node/Documents/HeritagePlaceAds/errors";
mkdirSync(ERRORS, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(30_000);

// Sign in
await page.goto("https://sminfinity.com", { waitUntil: "networkidle" });
await page.locator('input[type="email"]').fill(email);
await page.locator('input[type="password"]').fill(password);
await page.locator('button[type="submit"]').click();
await page.waitForURL(/schedules|library|dashboard/, { timeout: 15_000 });
console.log("Signed in.");

// Go to editplaylist/2 (lunchTime)
await page.goto("https://sminfinity.com/editplaylist/2", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

// Screenshot
await page.screenshot({ path: join(ERRORS, "discover-editplaylist2-full.png"), fullPage: true });
console.log("Screenshot taken.");

// Dump ALL text content and links
const bodyText = await page.locator("body").innerText();
writeFileSync(join(ERRORS, "discover-editplaylist2-body.txt"), bodyText.slice(0, 20000));

// Dump all buttons with details
const buttons: any[] = [];
const btnCount = await page.locator("button").count();
for (let i = 0; i < btnCount; i++) {
  const b = page.locator("button").nth(i);
  buttons.push({
    text: ((await b.textContent()) || "").trim().slice(0, 80),
    title: await b.getAttribute("title"),
    aria: await b.getAttribute("aria-label"),
    class: ((await b.getAttribute("class")) || "").slice(0, 80),
    visible: await b.isVisible(),
  });
}
writeFileSync(
  join(ERRORS, "discover-editplaylist2-buttons.json"),
  JSON.stringify(buttons, null, 2),
);

// Dump all links (a tags)
const links: any[] = [];
const linkCount = await page.locator("a").count();
for (let i = 0; i < linkCount; i++) {
  const a = page.locator("a").nth(i);
  links.push({
    text: ((await a.textContent()) || "").trim().slice(0, 80),
    href: await a.getAttribute("href"),
    visible: await a.isVisible(),
  });
}
writeFileSync(join(ERRORS, "discover-editplaylist2-links.json"), JSON.stringify(links, null, 2));

console.log(`Buttons: ${btnCount}, Links: ${linkCount}`);
console.log("Body preview:", bodyText.slice(0, 500));

await browser.close();
