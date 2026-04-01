/**
 * upload-ads.ts
 *
 * Confirmed flow (2026-03-26):
 *   For each timeslot:
 *     1. Open editplaylist via pencil on /schedules
 *     2. Remove old company items (click i.mdi-delete.v-icon--clickable)
 *     3. Upload new images → they are auto-added to the playlist on upload
 *     4. Wait ~5s for the success snackbar to clear
 *     5. Save via JS click on "Save & Exit"
 *
 * File management: ToUpload → Live, replaced Live files → Archived
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { chromium, type Page } from "playwright";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ADS_DIR = join(homedir(), "Documents", "HeritagePlaceAds");
const TO_UPLOAD = join(ADS_DIR, "ToUpload");
const LIVE = join(ADS_DIR, "Live");
const ARCHIVED = join(ADS_DIR, "Archived");
const ERRORS = join(ADS_DIR, "errors");

// ---------------------------------------------------------------------------
// Schedule row labels
// ---------------------------------------------------------------------------
const TIMESLOT_ROW_TEXT: Record<string, string> = {
  lunchTime: "Lunch Time",
  morning: "Morning",
  evening: "Evening",
};
const ALL_TIMESLOTS = Object.keys(TIMESLOT_ROW_TEXT);

// ---------------------------------------------------------------------------
// Filename parsing  —  {COMPANY}_{YYYY-MM-DD}_{randomId}_{timeslot}.{ext}
// ---------------------------------------------------------------------------
type ParsedImage = {
  company: string;
  date: string;
  randomId: string;
  timeslot: string;
  filename: string;
  fullPath: string;
};

function parseImageFilename(fp: string): ParsedImage | null {
  const fname = basename(fp);
  const ext = extname(fname);
  const parts = fname.slice(0, -ext.length).split("_");
  if (parts.length < 3) return null;
  return {
    company: parts[0],
    date: parts[1],
    randomId: parts[2],
    timeslot: parts[3] || "all",
    filename: fname,
    fullPath: fp,
  };
}

function groupByTimeslot(images: ParsedImage[]): Record<string, ParsedImage[]> {
  const g: Record<string, ParsedImage[]> = { lunchTime: [], morning: [], evening: [] };
  for (const img of images) {
    if (img.timeslot === "all") {
      for (const s of ALL_TIMESLOTS) g[s].push(img);
    } else if (g[img.timeslot]) g[img.timeslot].push(img);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function screenshotOnError(page: Page, label: string): Promise<void> {
  try {
    mkdirSync(ERRORS, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await page.screenshot({ path: join(ERRORS, `${label}_${ts}.png`), fullPage: true });
  } catch {
    /* best-effort */
  }
}

async function goToSchedules(page: Page): Promise<void> {
  if (!page.url().includes("/schedules")) {
    await page.goto("https://sminfinity.com/schedules", { waitUntil: "domcontentloaded" });
  }
  await page.waitForSelector("tbody tr", { timeout: 15_000 });
  await page.waitForTimeout(300);
}

async function openEditPlaylist(page: Page, rowText: string): Promise<void> {
  await goToSchedules(page);
  for (const row of await page.locator("tbody tr").all()) {
    if ((await row.textContent())?.includes(rowText)) {
      await row.locator("button:has(.mdi-pencil)").click();
      await page.waitForURL(/editplaylist/, { timeout: 10_000 });
      await page.waitForSelector(".dndrop-container", { timeout: 15_000 });
      await page.waitForTimeout(1500);
      return;
    }
  }
  throw new Error(`Schedule row not found: "${rowText}"`);
}

/** Drag-drop real files onto the active upload drawer's drop zone */
async function dropFilesToUploadZone(page: Page, filePaths: string[]): Promise<void> {
  const files = filePaths.map((p) => ({
    b64: readFileSync(p).toString("base64"),
    fname: basename(p),
    mime: p.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
  }));
  await page.evaluate(async (fd: { b64: string; fname: string; mime: string }[]) => {
    const drawer = Array.from(document.querySelectorAll(".v-navigation-drawer--right")).find(
      (d) => !d.hasAttribute("inert") && (d as HTMLElement).style.transform === "translateX(0px)",
    ) as HTMLElement;
    const dropZone = drawer?.querySelector(".v-sheet.bg-indigo-lighten-4") as HTMLElement | null;
    if (!dropZone) throw new Error("Upload drop zone not found");
    const dt = new DataTransfer();
    for (const { b64, fname, mime } of fd)
      dt.items.add(
        new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], fname, { type: mime }),
      );
    dropZone.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 300));
    dropZone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  }, files);
}

// ---------------------------------------------------------------------------
// Process one timeslot
// ---------------------------------------------------------------------------
async function processTimeslot(
  page: Page,
  timeslot: string,
  images: ParsedImage[],
): Promise<string[]> {
  const rowText = TIMESLOT_ROW_TEXT[timeslot];
  const companies = [...new Set(images.map((i) => i.company))];
  const stems = images.map((i) => i.filename.replace(/\.[^.]+$/, ""));
  const removedFromLive: string[] = [];

  console.log(`\n[${timeslot}] Opening "${rowText}"...`);
  await openEditPlaylist(page, rowText);

  // -- Remove old playlist items for these companies --
  console.log(`  Removing old items for: ${companies.join(", ")}...`);
  let removedCount = 0;
  for (let attempt = 0; attempt < 50; attempt++) {
    const hit = await page.evaluate(
      ({ companiesList, skipStems }: { companiesList: string[]; skipStems: string[] }) => {
        for (const item of document.querySelectorAll(".dndrop-draggable-wrapper")) {
          const alt = (item.querySelector("img") as HTMLImageElement | null)?.alt || "";
          if (!companiesList.some((c) => alt.toLowerCase().startsWith(c.toLowerCase()))) continue;
          if (skipStems.some((s) => alt === s)) continue;
          const icon = item.querySelector("i.mdi-delete.v-icon--clickable") as HTMLElement | null;
          if (!icon) continue;
          return { found: true, alt };
        }
        return { found: false, alt: "" };
      },
      { companiesList: companies, skipStems: stems },
    );

    if (!hit.found) break;
    const altToRemove = hit.alt;

    const countBefore = await page.evaluate(
      () => document.querySelectorAll(".dndrop-draggable-wrapper").length,
    );

    // Use JS click — the icon may be below viewport, mouse.click won't reach it
    await page.evaluate(
      ({ companiesList, skipStems }: { companiesList: string[]; skipStems: string[] }) => {
        for (const item of document.querySelectorAll(".dndrop-draggable-wrapper")) {
          const alt = (item.querySelector("img") as HTMLImageElement | null)?.alt || "";
          if (!companiesList.some((c) => alt.toLowerCase().startsWith(c.toLowerCase()))) continue;
          if (skipStems.some((s) => alt === s)) continue;
          const icon = item.querySelector("i.mdi-delete.v-icon--clickable") as HTMLElement | null;
          if (icon) {
            icon.click();
            return;
          }
        }
      },
      { companiesList: companies, skipStems: stems },
    );

    // Wait for count to drop
    await page
      .waitForFunction(
        (n: number) => document.querySelectorAll(".dndrop-draggable-wrapper").length < n,
        countBefore,
        { timeout: 5_000 },
      )
      .catch(() => null);
    await page.waitForTimeout(300);
    removedCount++;
    console.log(`  Removed: ${altToRemove}`);

    if (existsSync(LIVE)) {
      for (const lf of readdirSync(LIVE)) {
        if (
          companies.some((c) => lf.toLowerCase().startsWith(c.toLowerCase())) &&
          !removedFromLive.includes(lf)
        )
          removedFromLive.push(lf);
      }
    }
  }
  console.log(removedCount > 0 ? `  Removed ${removedCount} item(s).` : `  Nothing to remove.`);

  // -- Upload images (auto-added to playlist on success) --
  console.log(`  Uploading ${images.length} image(s)...`);
  await page
    .locator("button:has(.mdi-cloud-upload-outline)")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("button:has(.mdi-cloud-upload-outline)").first().click();

  await page.waitForFunction(
    () => {
      const d = Array.from(document.querySelectorAll(".v-navigation-drawer--right")).find(
        (d) => !d.hasAttribute("inert") && (d as HTMLElement).style.transform === "translateX(0px)",
      );
      return !!d?.querySelector(".v-sheet.bg-indigo-lighten-4");
    },
    { timeout: 10_000 },
  );

  await dropFilesToUploadZone(
    page,
    images.map((i) => i.fullPath),
  );
  await page.waitForTimeout(800);

  // Wait for Start Uploads to enable
  await page.waitForFunction(
    () => {
      const d = Array.from(document.querySelectorAll(".v-navigation-drawer--right")).find(
        (d) => !d.hasAttribute("inert") && (d as HTMLElement).style.transform === "translateX(0px)",
      );
      const btn = Array.from(d?.querySelectorAll("button") || []).find((b) =>
        b.textContent?.includes("Start Uploads"),
      ) as HTMLButtonElement | null;
      return btn && !btn.disabled;
    },
    { timeout: 10_000 },
  );

  await page
    .locator(".v-navigation-drawer--right:not([inert]) button:has-text('Start Uploads')")
    .first()
    .click();
  console.log(`  Uploading...`);

  // Wait for upload drawer to close (upload complete, items auto-added to playlist)
  await page.waitForFunction(
    () => {
      return !Array.from(document.querySelectorAll(".v-navigation-drawer--right")).some(
        (d) => !d.hasAttribute("inert") && (d as HTMLElement).style.transform === "translateX(0px)",
      );
    },
    { timeout: 60_000 },
  );
  console.log(`  Upload complete — images auto-added to playlist.`);

  // Wait for the success snackbar to fully clear (~5s) before saving
  console.log(`  Waiting for snackbar to clear...`);
  await page
    .waitForFunction(
      () => {
        const snackbar = document.querySelector(".v-snackbar__content") as HTMLElement | null;
        return !snackbar || snackbar.getBoundingClientRect().width === 0;
      },
      { timeout: 15_000 },
    )
    .catch(() => null);
  await page.waitForTimeout(500); // small buffer after snackbar gone

  // Verify auto-add
  const playlistAlts = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".dndrop-draggable-wrapper img[alt]")).map((i) =>
      i.getAttribute("alt"),
    ),
  );
  for (const stem of stems) {
    if (playlistAlts.some((a) => a === stem)) {
      console.log(`  ✓ ${stem} in playlist.`);
    } else {
      console.warn(`  ⚠ ${stem} not found in playlist — may need manual check.`);
    }
  }

  // -- Save via JS click (body overlay blocks Playwright's pointer click) --
  console.log(`  Saving...`);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save & Exit" && b.getBoundingClientRect().width > 0,
    ) as HTMLButtonElement | null;
    btn?.click();
  });

  // Wait to return to /schedules
  await Promise.race([
    page.waitForURL(/schedules/, { timeout: 15_000 }),
    page.waitForFunction(() => !!document.querySelector("tbody tr"), { timeout: 15_000 }),
  ]).catch(() => null);
  if (!page.url().includes("/schedules")) {
    await page.goto("https://sminfinity.com/schedules", { waitUntil: "domcontentloaded" });
  }
  await page.waitForSelector("tbody tr", { timeout: 15_000 });
  console.log(`  [${timeslot}] Saved.`);

  return removedFromLive;
}

// ---------------------------------------------------------------------------
// Expand _all files into per-timeslot copies so each timeslot upload uses
// a unique filename — avoids duplicate-detection errors on SMInfinity.
// ---------------------------------------------------------------------------
function expandAllTimeslots(images: ParsedImage[]): ParsedImage[] {
  const expanded: ParsedImage[] = [];
  for (const img of images) {
    if (img.timeslot !== "all") {
      expanded.push(img);
      continue;
    }
    for (const slot of ALL_TIMESLOTS) {
      const ext = extname(img.filename);
      const newName = `${img.company}_${img.date}_${img.randomId}_${slot}${ext}`;
      const newPath = join(TO_UPLOAD, newName);
      // Copy the file with the slot-specific name if it doesn't already exist
      if (!existsSync(newPath)) {
        copyFileSync(img.fullPath, newPath);
        console.log(`  Expanded: ${img.filename} → ${newName}`);
      }
      expanded.push({ ...img, timeslot: slot, filename: newName, fullPath: newPath });
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const email = process.env.SMINFINITY_EMAIL;
  const password = process.env.SMINFINITY_PASSWORD;
  if (!email || !password) {
    console.error("Missing SMINFINITY_EMAIL or SMINFINITY_PASSWORD");
    process.exit(1);
  }

  if (!existsSync(TO_UPLOAD)) {
    console.log("ToUpload directory does not exist.");
    process.exit(0);
  }
  const files = readdirSync(TO_UPLOAD).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (files.length === 0) {
    console.log("No images in ToUpload.");
    process.exit(0);
  }

  const rawImages = files
    .map((f) => parseImageFilename(join(TO_UPLOAD, f)))
    .filter((p): p is ParsedImage => p !== null);
  if (rawImages.length === 0) {
    console.error("No files matched naming format: {COMPANY}_{DATE}_{ID}_{TIMESLOT}.{ext}");
    process.exit(1);
  }

  // Expand _all files into per-timeslot copies before uploading
  console.log("Expanding _all files into per-timeslot copies...");
  const images = expandAllTimeslots(rawImages);

  const groups = groupByTimeslot(images);
  const companies = [...new Set(images.map((i) => i.company))];
  // Track original _all source files so we can delete them after slot copies are moved
  const originalAllFiles = rawImages.filter((i) => i.timeslot === "all").map((i) => i.fullPath);
  const allRemoved: string[] = [];

  console.log(`Found ${images.length} image(s) for: ${companies.join(", ")}`);
  console.log(
    `Timeslots:`,
    Object.entries(groups)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `${k}(${v.length})`)
      .join(", "),
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(45_000);

  try {
    console.log("\nSigning in...");
    await page.goto("https://sminfinity.com", { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/schedules|library|dashboard/, { timeout: 20_000 });
    await page.waitForSelector("tbody tr", { timeout: 15_000 }).catch(() => null);
    console.log("Signed in.\n");

    for (const timeslot of ALL_TIMESLOTS) {
      const slotImages = groups[timeslot];
      if (slotImages.length === 0) {
        console.log(`[${timeslot}] No images, skipping.`);
        continue;
      }
      try {
        allRemoved.push(...(await processTimeslot(page, timeslot, slotImages)));
      } catch (err) {
        console.error(`\n[${timeslot}] FAILED: ${(err as Error).message}`);
        await screenshotOnError(page, `${timeslot}-error`);
        throw err;
      }
    }

    console.log("\nMoving files...");
    mkdirSync(LIVE, { recursive: true });
    mkdirSync(ARCHIVED, { recursive: true });

    const moved = new Set<string>();
    for (const img of images) {
      if (moved.has(img.filename)) continue;
      try {
        renameSync(img.fullPath, join(LIVE, img.filename));
        moved.add(img.filename);
        console.log(`  ToUpload -> Live: ${img.filename}`);
      } catch (err) {
        console.warn(`  Warning: could not move ${img.filename}: ${(err as Error).message}`);
      }
    }
    // Remove original _all source files (already expanded into slot copies above)
    for (const origPath of originalAllFiles) {
      if (existsSync(origPath)) {
        try {
          unlinkSync(origPath);
          console.log(`  Deleted original _all: ${basename(origPath)}`);
        } catch (err) {
          console.warn(
            `  Warning: could not delete ${basename(origPath)}: ${(err as Error).message}`,
          );
        }
      }
    }
    for (const lf of [...new Set(allRemoved)]) {
      const src = join(LIVE, lf);
      if (existsSync(src)) {
        try {
          renameSync(src, join(ARCHIVED, lf));
          console.log(`  Live -> Archived: ${lf}`);
        } catch (err) {
          console.warn(`  Warning: could not archive ${lf}: ${(err as Error).message}`);
        }
      }
    }

    console.log("\nAll done.");
  } catch (err) {
    console.error("Upload failed:", (err as Error).message);
    await screenshotOnError(page, "upload-failure");
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
