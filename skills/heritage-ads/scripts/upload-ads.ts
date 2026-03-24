import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
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
// Timeslot -> editplaylist URL mapping
// ---------------------------------------------------------------------------
const TIMESLOT_URLS: Record<string, string> = {
  lunchTime: "https://sminfinity.com/editplaylist/2",
  morning: "https://sminfinity.com/editplaylist/3",
  evening: "https://sminfinity.com/editplaylist/4",
};

const ALL_TIMESLOTS = Object.keys(TIMESLOT_URLS);

// ---------------------------------------------------------------------------
// Filename parsing
// Format: {COMPANY}_{YYYY-MM-DD}_{randomId}_{timeslot}.{ext}
// ---------------------------------------------------------------------------
type ParsedImage = {
  company: string;
  date: string;
  randomId: string;
  timeslot: string;
  filename: string;
  fullPath: string;
};

function parseImageFilename(filepath: string): ParsedImage | null {
  const fname = basename(filepath);
  const ext = extname(fname);
  const stem = fname.slice(0, -ext.length);
  const parts = stem.split("_");

  if (parts.length < 3) return null;

  const company = parts[0];
  const date = parts[1];
  const randomId = parts[2];
  const timeslot = parts[3] || "all";

  return { company, date, randomId, timeslot, filename: fname, fullPath: filepath };
}

// ---------------------------------------------------------------------------
// Group images by timeslot (images with "all" go into every group)
// ---------------------------------------------------------------------------
function groupByTimeslot(images: ParsedImage[]): Record<string, ParsedImage[]> {
  const groups: Record<string, ParsedImage[]> = {
    lunchTime: [],
    morning: [],
    evening: [],
  };

  for (const img of images) {
    if (img.timeslot === "all") {
      for (const slot of ALL_TIMESLOTS) groups[slot].push(img);
    } else if (groups[img.timeslot]) {
      groups[img.timeslot].push(img);
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Screenshot on failure helper
// ---------------------------------------------------------------------------
async function screenshotOnError(page: Page, label: string): Promise<void> {
  try {
    mkdirSync(ERRORS, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await page.screenshot({ path: join(ERRORS, `${label}_${ts}.png`), fullPage: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper for navigation actions
// ---------------------------------------------------------------------------
async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main script
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const email = process.env.SMINFINITY_EMAIL;
  const password = process.env.SMINFINITY_PASSWORD;

  if (!email || !password) {
    console.error("Missing SMINFINITY_EMAIL or SMINFINITY_PASSWORD environment variables");
    process.exit(1);
  }

  // Parse ToUpload folder
  if (!existsSync(TO_UPLOAD)) {
    console.log("ToUpload directory does not exist, nothing to do.");
    process.exit(0);
  }

  const files = readdirSync(TO_UPLOAD).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (files.length === 0) {
    console.log("No images in ToUpload, nothing to do.");
    process.exit(0);
  }

  const images = files
    .map((f) => parseImageFilename(join(TO_UPLOAD, f)))
    .filter((p): p is ParsedImage => p !== null);

  if (images.length === 0) {
    console.error(
      "No files matched the expected naming format: {COMPANY}_{DATE}_{ID}_{TIMESLOT}.{ext}",
    );
    process.exit(1);
  }

  const groups = groupByTimeslot(images);
  const companiesInBatch = [...new Set(images.map((i) => i.company))];
  const removedFromLive: string[] = [];

  console.log(`Found ${images.length} image(s) for companies: ${companiesInBatch.join(", ")}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  try {
    // -- Step 1: Sign in --
    console.log("Signing in to sminfinity.com...");
    await withRetry(() => page.goto("https://sminfinity.com", { waitUntil: "networkidle" }));

    // Selectors verified via discover-selectors.ts against live site
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();

    await page.waitForURL(/schedules|library|dashboard/, { timeout: 15_000 });
    console.log("Signed in successfully.");

    // -- Step 3: Process each timeslot --
    for (const timeslot of ALL_TIMESLOTS) {
      const slotImages = groups[timeslot];
      if (slotImages.length === 0) {
        console.log(`No images for ${timeslot}, skipping.`);
        continue;
      }

      const slotCompanies = [...new Set(slotImages.map((i) => i.company))];
      const url = TIMESLOT_URLS[timeslot];
      console.log(
        `\nProcessing ${timeslot} (${slotImages.length} images, companies: ${slotCompanies.join(", ")})...`,
      );

      await withRetry(() => page.goto(url, { waitUntil: "networkidle" }));
      await page.waitForTimeout(1500);

      // -- Step 3a: Remove old images for matching companies --
      console.log("  Checking for existing images to remove...");
      try {
        // Verified: section:has-text("Playlist Media") matches on the editplaylist pages
        const playlistSection = page.locator('section:has-text("Playlist Media")').first();
        const mediaItems = playlistSection.locator(
          '[class*="media-item"], [class*="MediaItem"], tr, [class*="item"]',
        );
        const count = await mediaItems.count();

        for (let i = count - 1; i >= 0; i--) {
          const item = mediaItems.nth(i);
          const text = (await item.textContent()) || "";

          for (const company of slotCompanies) {
            if (text.toLowerCase().includes(company.toLowerCase())) {
              console.log(
                `  Removing old media: "${text.trim().slice(0, 60)}..." (matches ${company})`,
              );

              const trashBtn = item
                .locator(
                  '[title="Remove Media"], button:has-text("Remove"), [aria-label*="remove" i], [aria-label*="delete" i]',
                )
                .first();
              if (await trashBtn.isVisible()) {
                await trashBtn.click();
                await page.waitForTimeout(500);

                // Track removed file for archival
                if (existsSync(LIVE)) {
                  const liveFiles = readdirSync(LIVE);
                  for (const lf of liveFiles) {
                    if (lf.toLowerCase().startsWith(company.toLowerCase())) {
                      removedFromLive.push(lf);
                    }
                  }
                }
              }
              break;
            }
          }
        }
      } catch (err) {
        console.warn(
          "  Warning: could not inspect playlist media section:",
          (err as Error).message,
        );
      }

      // -- Step 3b: Upload new images --
      console.log("  Uploading new images...");
      const filePaths = slotImages.map((i) => i.fullPath);

      // Verified: input[type="file"][name="file"] exists on editplaylist pages
      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles(filePaths);
      await page.waitForTimeout(3000);
      console.log(`  Uploaded ${filePaths.length} file(s) via file input.`);

      // -- Step 3c: Add uploaded images to playlist --
      console.log("  Adding uploaded images to playlist...");
      for (const img of slotImages) {
        try {
          // Verified: [aria-label*="search" i] toggles a search input
          const searchIcon = page.locator('[aria-label*="search" i]').first();
          if (await searchIcon.isVisible()) {
            await searchIcon.click();
            await page.waitForTimeout(500);
          }

          // Type filename to filter (try search-specific inputs first, fall back to text)
          const searchInput = page
            .locator(
              'input[type="search"], input[placeholder*="search" i], input[placeholder*="Search"]',
            )
            .first();
          await searchInput.fill(img.filename);
          await page.waitForTimeout(1500);

          // Verified: button:has-text("Add") exists in media library
          const addBtn = page.locator('button:has-text("Add")').first();
          if (await addBtn.isVisible()) {
            await addBtn.click();
            await page.waitForTimeout(500);
            console.log(`  Added ${img.filename} to playlist.`);
          } else {
            console.warn(`  Warning: could not find Add button for ${img.filename}`);
          }

          await searchInput.clear();
          await page.waitForTimeout(300);
        } catch (err) {
          console.warn(`  Warning: failed to add ${img.filename}:`, (err as Error).message);
        }
      }

      // -- Step 3d: Save --
      console.log("  Saving changes...");
      // Verified: button:has-text("Save") exists on editplaylist pages
      const saveBtn = page.locator('button:has-text("Save")').first();
      await saveBtn.click();
      await page.waitForTimeout(2000);
      console.log(`  ${timeslot} playlist saved.`);
    }

    // -- Step 4: File management --
    console.log("\nMoving files...");
    mkdirSync(LIVE, { recursive: true });
    mkdirSync(ARCHIVED, { recursive: true });

    // Move uploaded images from ToUpload -> Live
    const movedFiles = new Set<string>();
    for (const img of images) {
      if (movedFiles.has(img.filename)) continue;
      const dest = join(LIVE, img.filename);
      try {
        renameSync(img.fullPath, dest);
        movedFiles.add(img.filename);
        console.log(`  ToUpload -> Live: ${img.filename}`);
      } catch (err) {
        console.warn(`  Warning: could not move ${img.filename}:`, (err as Error).message);
      }
    }

    // Move removed company images from Live -> Archived
    for (const lf of [...new Set(removedFromLive)]) {
      const src = join(LIVE, lf);
      if (existsSync(src)) {
        const dest = join(ARCHIVED, lf);
        try {
          renameSync(src, dest);
          console.log(`  Live -> Archived: ${lf}`);
        } catch (err) {
          console.warn(`  Warning: could not archive ${lf}:`, (err as Error).message);
        }
      }
    }

    console.log("\nDone.");
  } catch (err) {
    console.error("Upload failed:", (err as Error).message);
    await screenshotOnError(page, "upload-failure");
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
