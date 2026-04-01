---
name: heritage-ads
description: "Automated Heritage Place digital signage ad management. Use when checking email for new ad images, classifying which company they belong to, and uploading them to the sminfinity.com digital signage platform. Triggered by the heritage-ads:email-check cron job, or manually when the user asks to check for new ads, upload ads, or manage Heritage Place signage."
metadata: { "openclaw": { "requires": { "bins": ["node"] } } }
---

# Heritage Place Ad Automation

Manage digital signage ads for Heritage Place Shopping Center. Emails arrive with ad images from tenant businesses; this skill checks for them, classifies them by company, and uploads them to sminfinity.com.

## Prerequisites

1. IMAP credentials configured: `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS` in environment.
   - Optional connection tuning: `IMAP_CONNECT_TIMEOUT_MS` (default `20000`), `IMAP_CONNECT_RETRIES` (default `2`), `IMAP_CONNECT_RETRY_DELAY_MS` (default `4000`).
   - Optional mailbox tuning: `IMAP_SOCKET_TIMEOUT_MS` (defaults to `IMAP_CONNECT_TIMEOUT_MS`), `IMAP_INITIAL_UID_WINDOW` (default `5000`, only used on first run before `.last-check-uid` exists).
   - Optional transport tuning: `IMAP_SECURE` (defaults to `true` when port is `993`, otherwise `false`), `IMAP_PREFLIGHT` (default `true`, set `false` to skip DNS/TCP/TLS preflight probe).
2. SM Infinity credentials configured: `SMINFINITY_EMAIL`, `SMINFINITY_PASSWORD` in environment.
3. Dependencies installed: run `npm install` in `skills/heritage-ads/scripts/` and `npx playwright install chromium`.
4. Company config populated: edit `references/companies.json` and `references/sender-map.json`.

## Directory Layout

```
~/Documents/HeritagePlaceAds/
  ToUpload/   -- new images ready for upload
  Live/       -- currently active images on sminfinity
  Archived/   -- removed images (historical record)
  errors/     -- screenshots from failed upload attempts
```

## File Naming Convention

```
{COMPANY}_{YYYY-MM-DD}_{randomId}_{timeslot}.{ext}
```

- `timeslot`: `lunchTime`, `morning`, `evening`, or `all` (default)
- `ext`: `.png` or `.jpg`
- Example: `Acme_2026-02-26_a3f2_lunchTime.png`

Generate `randomId` as 4 hex chars (`crypto.randomBytes(2).toString("hex")`).

## Workflow (follow in order)

### Step 1: Check for new emails

Run `scripts/check-email.ts` (from the skill's `scripts/` directory):

`node --experimental-strip-types check-email.ts`

Read the JSON output. If `newEmails` is 0, reply `HEARTBEAT_OK` and **stop immediately**. Do nothing else.

### Step 2: Classify each email

For each email in the output, determine which company it belongs to using three methods **in order**:

#### Method A: Deterministic

Run `scripts/classify.ts` by piping the email JSON (with `sender`, `subject`, `body` fields) to stdin. If the result has `method: "sender-map"` or `method: "keyword"`, use the returned `company`.

Alternatively, apply these rules directly:

1. Check if `sender` matches any key in `references/sender-map.json` (case-insensitive). If so, use the mapped company name.
2. Check if any company name from `references/companies.json` appears in the email subject or body (case-insensitive substring match). If so, use that company.

#### Method B: AI classification

If Method A returns `method: "none"`, you have the email context and the list of allowed companies from `references/companies.json`. Use your judgment to pick the best match. Only proceed if you are confident in the match.

#### Method C: Telegram fallback

If you cannot determine the company with confidence, send a Telegram message containing:

- The email sender, subject, and a body snippet (first 500 chars)
- The attached image(s) as media files
- The numbered list of companies from `references/companies.json`
- Ask: "Which company is this ad from? Reply with the number. Also confirm timeslots (default: all three -- lunchTime, morning, evening). Reply like: `2` or `3 morning evening`"

Wait for the user's response before continuing.

### Step 2b: Detect single-image edge cases

After classification, check the number of image attachments and the email body for edge case language. Do this **before** proceeding to Step 3.

#### Partial replacement detection

Scan the email subject and body for phrases indicating the company wants to replace only ONE of their currently running ads:

- "replace", "swap out", "update only one", "change only one", "swap one", "replace one", "just update", "only replace", "substitute"

If partial-replacement language is detected AND there is exactly **one** attachment:

1. Find all files in `~/Documents/HeritagePlaceAds/Live/` that start with the company name (case-insensitive).
2. Send a Telegram message to Adam containing:
   - The new ad image as an attachment
   - Each matching Live file as a separate attachment (numbered 1, 2, etc.)
   - This message:
     > _"[Company] wants to replace one of their current ads. Here's what's currently running:_
     > _Image 1: [filename]_
     > _Image 2: [filename]_
     > _New ad attached. Reply **1** or **2** to choose which one gets replaced."_
3. **Stop here.** Do not stage, upload, or log into SMInfinity. Wait for Adam's reply before proceeding.
4. Schedule a follow-up cron job (`kind: "at"`, 24 hours from now) with a reminder message:
   > _"Reminder: [Company] is waiting for you to choose which ad to replace. Reply 1 or 2 to proceed, or ignore if no longer needed."_
   > Cancel this cron job once Adam replies.
5. When Adam replies with "1" or "2":
   - Cancel the follow-up reminder cron job if it hasn't fired yet
   - Stage only the new image (Step 4), using the same timeslot as the file being replaced
   - In `upload-ads.ts`, the remove step will handle deletion of the old item; only the replaced company file should be removed (not all company files)
   - Proceed to Step 5

#### Single image, run twice

If there is exactly **one** attachment AND **no** partial-replacement language detected:

- Stage **two copies** of the image with different `randomId`s so it occupies two playlist slots
- Example: `Heritage_2026-03-27_a1b2_all.png` and `Heritage_2026-03-27_c3d4_all.png`
- Both will upload to all timeslot playlists, giving the company two rotation slots as intended

If there are **two or more** attachments, proceed normally — no duplication needed.

### Step 3: Determine timeslot and start date

#### Timeslot

If the email does not explicitly mention a timeslot (morning, lunch/lunchTime, evening), **default to `all`** — the ad runs on all three timeslots.

#### Start date

Parse the email body for a start date. Look for patterns like:

- "3/26", "3/26-4/8", "March 26", "starting 3/26", "to run 3/26-4/8", etc.

**Decision logic:**

- **No start date found** → proceed immediately to Step 4 (upload now)
- **Start date is today or in the past** → proceed immediately to Step 4
- **Start date is in the future** → **do NOT upload yet**. Instead:
  1. Stage the renamed images in `~/Documents/HeritagePlaceAds/ToUpload/` as normal
  2. Create a one-shot cron job to run `upload-ads.ts` at **8:00 AM MST/MDT** on the start date
     - Use schedule `kind: "at"` with the ISO timestamp for 8 AM Mountain Time on the start date
     - Name it `heritage-ads:scheduled:{COMPANY}:{YYYY-MM-DD}`
     - Payload: agentTurn to run the heritage-ads upload step
  3. Send a Telegram message: _"[Company] ad received — scheduled to go live [date] at 8 AM. I'll handle it."_
  4. **Stop here** — do not run Step 4 or 5 yet.

**Note on removal:** Ads are only removed when new ads arrive from the same company. There is no auto-remove on end date — the tenant or a new submission handles that.

### Step 4: Name and stage images

For each classified email:

1. Take each image attachment from the temp path provided in the check-email output.
2. Rename it to: `{COMPANY}_{YYYY-MM-DD}_{randomId}_{timeslot}.{ext}`
   - Use the **start date** (or today if no start date) for `YYYY-MM-DD`
   - Generate a 4-char hex `randomId`
   - Use the confirmed timeslot, or `all` if not specified
3. Move the renamed file to `~/Documents/HeritagePlaceAds/ToUpload/`

### Step 5: Upload to sminfinity.com

Run `scripts/upload-ads.ts` (from the skill's `scripts/` directory):

`node --experimental-strip-types upload-ads.ts`

The script will:

1. Sign into sminfinity.com
2. For each timeslot with images:
   - Open editplaylist via the pencil icon on `/schedules`
   - Remove old images matching the same company name
   - Upload new images (auto-added to playlist on upload)
   - Wait for success snackbar to clear (~5s)
   - Save via "Save & Exit"
3. Move files: `ToUpload/ -> Live/`, replaced `Live/ -> Archived/`

If the script fails, check `~/Documents/HeritagePlaceAds/errors/` for screenshots and report the error.

### Step 6: Confirm completion

After a successful upload, send a Telegram message summarizing what was done:

- Which companies had ads updated
- Which timeslots were affected
- How many images were uploaded
- If any ads were scheduled for a future date, include that too

## Cron Job Setup (first-time only)

Register the cron job that triggers this skill every 30 minutes:

```bash
openclaw cron add \
  --name "heritage-ads:email-check" \
  --every "1800000" \
  --session isolated \
  --message "Run the heritage-ads skill. First, execute check-email.ts from skills/heritage-ads/scripts/. If newEmails is 0, reply HEARTBEAT_OK and stop -- do nothing else. Only if there ARE new emails, proceed with classification and upload per SKILL.md." \
  --announce \
  --channel telegram \
  --to "<telegram-chat-id>"
```

Before creating, run `openclaw cron list` and check if `heritage-ads:email-check` already exists. If it does, use `openclaw cron edit <id>` instead.

## Troubleshooting

- **Sign-in failure**: Verify `SMINFINITY_EMAIL` and `SMINFINITY_PASSWORD` are correct. Check `errors/` for screenshots.
- **IMAP connection refused**: Verify `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`. Port 993 requires TLS.
- **IMAP connection timed out (`ETIMEOUT`)**: The script now retries automatically. If it still fails, run connectivity checks from the same runtime host/container (`nc -zv $IMAP_HOST $IMAP_PORT` or `openssl s_client -connect $IMAP_HOST:$IMAP_PORT`) and confirm firewall egress on the configured IMAP port.
- **No images extracted**: The email may not have image attachments, or they may be inline (not standard attachments). Check the raw email.
- **Playwright browser missing**: Run `npx playwright install chromium` in `skills/heritage-ads/scripts/`.
- **Selectors broken**: sminfinity.com may have updated their UI. Run `upload-ads.ts` with `--headed` (change `headless: true` to `false`) to watch the browser and identify new selectors.
