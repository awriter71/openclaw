/**
 * One-time selector discovery script for sminfinity.com.
 * Logs into the site, visits key pages, and records stable selectors
 * into references/selectors.json for the upload-ads script.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELECTORS_OUT = join(__dirname, "..", "references", "selectors.json");

const selectors: Record<string, Record<string, string>> = {
  login: {},
  schedules: {},
  editPlaylist: {},
  mediaLibrary: {},
};

async function main(): Promise<void> {
  const email = process.env.SMINFINITY_EMAIL;
  const password = process.env.SMINFINITY_PASSWORD;

  if (!email || !password) {
    console.error("Set SMINFINITY_EMAIL and SMINFINITY_PASSWORD env vars");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);

  try {
    // ---- LOGIN PAGE ----
    console.log("=== LOGIN PAGE ===");
    await page.goto("https://sminfinity.com", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    // Discover login form elements
    for (const sel of [
      'input[type="email"]',
      'input[name="email"]',
      "input#email",
      'input[autocomplete="email"]',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.login.emailInput = sel;
        console.log(`  Email input: ${sel}`);
        break;
      }
    }

    for (const sel of ['input[type="password"]', 'input[name="password"]', "input#password"]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.login.passwordInput = sel;
        console.log(`  Password input: ${sel}`);
        break;
      }
    }

    for (const sel of [
      'button[type="submit"]',
      'button:has-text("Sign In")',
      'button:has-text("Log In")',
      'button:has-text("Login")',
      'input[type="submit"]',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.login.submitButton = sel;
        console.log(`  Submit button: ${sel}`);
        break;
      }
    }

    // Actually log in
    if (
      selectors.login.emailInput &&
      selectors.login.passwordInput &&
      selectors.login.submitButton
    ) {
      await page.locator(selectors.login.emailInput).fill(email);
      await page.locator(selectors.login.passwordInput).fill(password);
      await page.locator(selectors.login.submitButton).click();
      await page.waitForURL(/schedules|library|dashboard/, { timeout: 15_000 });
      console.log("  Signed in successfully.");
    } else {
      console.error("  Could not find login form elements. Taking screenshot...");
      await page.screenshot({
        path: join(__dirname, "..", "references", "login-page.png"),
        fullPage: true,
      });
      // Try to dump all input and button elements
      const inputs = await page.locator("input").all();
      for (const inp of inputs) {
        const type = await inp.getAttribute("type");
        const name = await inp.getAttribute("name");
        const id = await inp.getAttribute("id");
        const placeholder = await inp.getAttribute("placeholder");
        console.log(`  input: type=${type} name=${name} id=${id} placeholder=${placeholder}`);
      }
      const buttons = await page.locator("button").all();
      for (const btn of buttons) {
        const text = await btn.textContent();
        const type = await btn.getAttribute("type");
        console.log(`  button: type=${type} text="${text?.trim()}"`);
      }
    }

    // ---- SCHEDULES PAGE ----
    console.log("\n=== SCHEDULES PAGE ===");
    await page.goto("https://sminfinity.com/schedules", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    // Nav tabs
    for (const sel of [
      'a[href="/library"]',
      'a:has-text("Library")',
      '[data-testid="library-tab"]',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.schedules.libraryTab = sel;
        console.log(`  Library tab: ${sel}`);
        break;
      }
    }

    for (const sel of [
      'a[href="/schedules"]',
      'a:has-text("Schedules")',
      '[data-testid="schedules-tab"]',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.schedules.schedulesTab = sel;
        console.log(`  Schedules tab: ${sel}`);
        break;
      }
    }

    // Table rows - look for edit icons with tooltip "edit playlist"
    const rows = await page.locator("tr, [class*='row']").all();
    console.log(`  Found ${rows.length} table rows`);

    for (const row of rows) {
      const text = (await row.textContent()) || "";
      const order = text.match(/\b([345])\b/);
      if (order) {
        const editBtn = row
          .locator('[title*="edit" i], [aria-label*="edit" i], button:has-text("Edit")')
          .first();
        if ((await editBtn.count()) > 0) {
          console.log(`  Row with order ${order[1]}: has edit button`);
        }
      }
    }

    // Look for edit playlist links/buttons
    for (const sel of [
      '[title="edit playlist"]',
      '[title="Edit Playlist"]',
      'a[href*="editplaylist"]',
      'button[title*="edit" i]',
    ]) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        selectors.schedules.editPlaylistButton = sel;
        console.log(`  Edit playlist buttons (${count} found): ${sel}`);
        break;
      }
    }

    // Screenshot schedules page
    await page.screenshot({
      path: join(__dirname, "..", "references", "schedules-page.png"),
      fullPage: true,
    });

    // ---- EDIT PLAYLIST PAGE (lunchTime = /editplaylist/2) ----
    console.log("\n=== EDIT PLAYLIST PAGE (lunchTime) ===");
    await page.goto("https://sminfinity.com/editplaylist/2", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    // Playlist Media section
    for (const sel of [
      '[class*="playlist-media"]',
      '[class*="PlaylistMedia"]',
      'section:has-text("Playlist Media")',
      '[data-testid*="playlist"]',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.editPlaylist.playlistMediaSection = sel;
        console.log(`  Playlist Media section: ${sel}`);
        break;
      }
    }

    // Remove/trash icon
    for (const sel of [
      '[title="Remove Media"]',
      '[aria-label="Remove Media"]',
      'button[title*="Remove" i]',
      'button[aria-label*="remove" i]',
      '[title*="trash" i]',
      '[title*="delete" i]',
    ]) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        selectors.editPlaylist.removeMediaButton = sel;
        console.log(`  Remove Media button (${count} found): ${sel}`);
        break;
      }
    }

    // Upload/file input
    for (const sel of ['input[type="file"]']) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.editPlaylist.fileInput = sel;
        console.log(`  File input: ${sel}`);
        break;
      }
    }

    // Upload button
    for (const sel of [
      'button:has-text("Upload")',
      'button:has-text("Select")',
      '[aria-label*="upload" i]',
      '[title*="upload" i]',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.editPlaylist.uploadButton = sel;
        console.log(`  Upload button: ${sel}`);
        break;
      }
    }

    // Search icon / search input in Media Library
    for (const sel of [
      '[aria-label*="search" i]',
      '[title*="Search" i]',
      'button:has-text("Search")',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.mediaLibrary.searchIcon = sel;
        console.log(`  Search icon: ${sel}`);
        break;
      }
    }

    for (const sel of [
      'input[type="search"]',
      'input[placeholder*="search" i]',
      'input[placeholder*="Search"]',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.mediaLibrary.searchInput = sel;
        console.log(`  Search input: ${sel}`);
        break;
      }
    }

    // Add file button
    for (const sel of [
      '[title*="Add" i]',
      'button:has-text("Add")',
      '[aria-label*="add file" i]',
    ]) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        selectors.mediaLibrary.addFileButton = sel;
        console.log(`  Add file button (${count} found): ${sel}`);
        break;
      }
    }

    // Save & Close button
    for (const sel of [
      'button:has-text("Save & Close")',
      'button:has-text("Save")',
      'button[type="submit"]:has-text("Save")',
    ]) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.editPlaylist.saveButton = sel;
        console.log(`  Save button: ${sel}`);
        break;
      }
    }

    // Cancel button
    for (const sel of ['button:has-text("Cancel")', 'a:has-text("Cancel")']) {
      if ((await page.locator(sel).count()) > 0) {
        selectors.editPlaylist.cancelButton = sel;
        console.log(`  Cancel button: ${sel}`);
        break;
      }
    }

    // Screenshot edit playlist page
    await page.screenshot({
      path: join(__dirname, "..", "references", "editplaylist-page.png"),
      fullPage: true,
    });

    // Dump all visible elements for reference
    console.log("\n=== FULL ELEMENT DUMP (edit playlist page) ===");
    const allButtons = await page.locator("button").all();
    for (const btn of allButtons) {
      if (await btn.isVisible()) {
        const text = (await btn.textContent())?.trim().slice(0, 60);
        const title = await btn.getAttribute("title");
        const ariaLabel = await btn.getAttribute("aria-label");
        console.log(`  button: text="${text}" title="${title}" aria-label="${ariaLabel}"`);
      }
    }

    const allInputs = await page.locator("input").all();
    for (const inp of allInputs) {
      const type = await inp.getAttribute("type");
      const name = await inp.getAttribute("name");
      const placeholder = await inp.getAttribute("placeholder");
      const ariaLabel = await inp.getAttribute("aria-label");
      console.log(
        `  input: type="${type}" name="${name}" placeholder="${placeholder}" aria-label="${ariaLabel}"`,
      );
    }

    // Save selectors
    writeFileSync(SELECTORS_OUT, JSON.stringify(selectors, null, 2));
    console.log(`\nSelectors saved to ${SELECTORS_OUT}`);
  } catch (err) {
    console.error("Discovery failed:", (err as Error).message);
    await page.screenshot({
      path: join(__dirname, "..", "references", "discovery-error.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
}

main();
