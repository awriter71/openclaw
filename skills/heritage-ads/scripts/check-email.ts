import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const ADS_DIR = join(homedir(), "Documents", "HeritagePlaceAds");
const UID_FILE = join(ADS_DIR, ".last-check-uid");
const TMP_DIR = join(ADS_DIR, ".tmp-attachments");

type EmailAttachment = {
  filename: string;
  path: string;
  mimeType: string;
};

type EmailResult = {
  uid: number;
  sender: string;
  subject: string;
  body: string;
  attachments: EmailAttachment[];
};

type CheckResult = {
  newEmails: number;
  emails: EmailResult[];
};

function getLastUid(): number {
  if (existsSync(UID_FILE)) {
    const val = parseInt(readFileSync(UID_FILE, "utf-8").trim(), 10);
    return Number.isNaN(val) ? 0 : val;
  }
  return 0;
}

function saveLastUid(uid: number): void {
  writeFileSync(UID_FILE, String(uid), "utf-8");
}

async function main(): Promise<void> {
  const host = process.env.IMAP_HOST;
  const port = parseInt(process.env.IMAP_PORT || "993", 10);
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;

  if (!host || !user || !pass) {
    console.error("Missing IMAP_HOST, IMAP_USER, or IMAP_PASS environment variables");
    process.exit(1);
  }

  const client = new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      const lastUid = getLastUid();

      // Search for unseen messages, optionally restricted to UIDs above last processed
      const searchQuery: Record<string, unknown> = { seen: false };
      if (lastUid > 0) {
        searchQuery.uid = `${lastUid + 1}:*`;
      }

      const uids = await client.search(searchQuery, { uid: true });

      if (!uids || uids.length === 0) {
        const result: CheckResult = { newEmails: 0, emails: [] };
        process.stdout.write(JSON.stringify(result) + "\n");
        return;
      }

      mkdirSync(TMP_DIR, { recursive: true });
      const emails: EmailResult[] = [];
      let maxUid = lastUid;

      const uidRange = uids.join(",");
      for await (const msg of client.fetch(uidRange, { uid: true, source: true }, { uid: true })) {
        const parsed = await simpleParser(msg.source);

        const sender = parsed.from?.value?.[0]?.address || parsed.from?.text || "unknown";
        const subject = parsed.subject || "(no subject)";
        const body = parsed.text || "";

        const attachments: EmailAttachment[] = [];
        if (parsed.attachments) {
          for (const att of parsed.attachments) {
            const ct = att.contentType || "";
            if (!ct.startsWith("image/")) continue;

            const fname = att.filename || `attachment_${msg.uid}_${attachments.length}.jpg`;
            const outPath = join(TMP_DIR, `${msg.uid}_${fname}`);
            writeFileSync(outPath, att.content);
            attachments.push({
              filename: fname,
              path: outPath,
              mimeType: ct,
            });
          }
        }

        emails.push({ uid: msg.uid, sender, subject, body, attachments });

        if (msg.uid > maxUid) maxUid = msg.uid;

        await client.messageFlagsAdd({ uid: msg.uid.toString() }, ["\\Seen"], { uid: true });
      }

      if (maxUid > lastUid) {
        saveLastUid(maxUid);
      }

      const result: CheckResult = { newEmails: emails.length, emails };
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

main().catch((err) => {
  console.error("check-email failed:", err.message || err);
  process.exit(1);
});
