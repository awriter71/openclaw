---
name: heritage-ads
description: "Automated Heritage Place digital signage ad management. Use when checking email for new ad images, classifying which company they belong to, and uploading them to the sminfinity.com digital signage platform. Triggered by the heritage-ads:email-check cron job, or manually when the user asks to check for new ads, upload ads, or manage Heritage Place signage."
metadata: { "openclaw": { "requires": { "bins": ["node"] } } }
---

# Heritage Place Ad Automation

Manage digital signage ads for Heritage Place Shopping Center. Emails arrive with ad images from tenant businesses; this skill checks for them, classifies them by company, and uploads them to sminfinity.com.

## Prerequisites

1. IMAP credentials configured: `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS` in environment.
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

Run `scripts/check-email.ts` (via `npx tsx scripts/check-email.ts` from the skill's `scripts/` directory).

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

### Step 3: Name and stage images

For each classified email:

1. Take each image attachment from the temp path provided in the check-email output.
2. Rename it to: `{COMPANY}_{YYYY-MM-DD}_{randomId}_{timeslot}.{ext}`
   - Use today's date for `YYYY-MM-DD`
   - Generate a 4-char hex `randomId`
   - Use the confirmed timeslot, or `all` if not specified
3. Move the renamed file to `~/Documents/HeritagePlaceAds/ToUpload/`

### Step 4: Upload to sminfinity.com

Run `scripts/upload-ads.ts` (via `npx tsx scripts/upload-ads.ts` from the skill's `scripts/` directory).

The script will:

1. Sign into sminfinity.com
2. For each timeslot with images, navigate to the editplaylist page:
   - `lunchTime` -> `sminfinity.com/editplaylist/2`
   - `morning` -> `sminfinity.com/editplaylist/3`
   - `evening` -> `sminfinity.com/editplaylist/4`
3. Remove old images matching the same company names
4. Upload the new images
5. Add them to the playlist and save
6. Move files: `ToUpload/ -> Live/`, old `Live/ -> Archived/`

If the script fails, check `~/Documents/HeritagePlaceAds/errors/` for screenshots and report the error.

### Step 5: Confirm completion

After a successful upload, send a Telegram message summarizing what was done:

- Which companies had ads updated
- Which timeslots were affected
- How many images were uploaded

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
- **No images extracted**: The email may not have image attachments, or they may be inline (not standard attachments). Check the raw email.
- **Playwright browser missing**: Run `npx playwright install chromium` in `skills/heritage-ads/scripts/`.
- **Selectors broken**: sminfinity.com may have updated their UI. Run `upload-ads.ts` with `--headed` (change `headless: true` to `false`) to watch the browser and identify new selectors.
