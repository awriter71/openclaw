import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as connectNet } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
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

type PreflightResult = {
  host: string;
  port: number;
  dnsAddress: string;
  tcpMs: number;
  tlsMs: number | null;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function createDebugLogger(enabled: boolean): (msg: string) => void {
  return (msg: string) => {
    if (enabled) console.error(`[check-email debug] ${msg}`);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code =
    (err as { code?: string }).code ??
    (err.cause && typeof err.cause === "object"
      ? (err.cause as { code?: string }).code
      : undefined);
  return err.message.toLowerCase().includes("timeout") || code === "ETIMEOUT";
}

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

async function runImapPreflight(
  host: string,
  port: number,
  timeoutMs: number,
  secure: boolean,
): Promise<PreflightResult> {
  const dnsResult = await lookup(host);

  const tcpMs = await new Promise<number>((resolve, reject) => {
    const start = Date.now();
    const socket = connectNet({ host, port });

    const onError = (err: Error): void => {
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`TCP preflight timeout after ${timeoutMs}ms`));
    });

    socket.once("error", onError);
    socket.once("connect", () => {
      const elapsed = Date.now() - start;
      socket.end();
      resolve(elapsed);
    });
  });

  let tlsMs: number | null = null;
  if (secure) {
    tlsMs = await new Promise<number>((resolve, reject) => {
      const start = Date.now();
      const socket = connectTls({
        host,
        port,
        servername: host,
        timeout: timeoutMs,
      });

      socket.once("error", (err) => {
        socket.destroy();
        reject(err);
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error(`TLS preflight timeout after ${timeoutMs}ms`));
      });
      socket.once("secureConnect", () => {
        const elapsed = Date.now() - start;
        socket.end();
        resolve(elapsed);
      });
    });
  }

  return {
    host,
    port,
    dnsAddress: dnsResult.address,
    tcpMs,
    tlsMs,
  };
}

async function main(): Promise<void> {
  const host = process.env.IMAP_HOST;
  const port = parsePositiveInt(process.env.IMAP_PORT, 993);
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  const connectTimeoutMs = parsePositiveInt(process.env.IMAP_CONNECT_TIMEOUT_MS, 20_000);
  const connectRetries = parsePositiveInt(process.env.IMAP_CONNECT_RETRIES, 2);
  const retryDelayMs = parsePositiveInt(process.env.IMAP_CONNECT_RETRY_DELAY_MS, 4_000);
  const socketTimeoutMs = parsePositiveInt(process.env.IMAP_SOCKET_TIMEOUT_MS, connectTimeoutMs);
  const initialUidWindow = parsePositiveInt(process.env.IMAP_INITIAL_UID_WINDOW, 5000);
  const secure = parseBoolean(process.env.IMAP_SECURE, port === 993);
  const preflightEnabled = parseBoolean(process.env.IMAP_PREFLIGHT, true);
  const debug = createDebugLogger(parseBoolean(process.env.IMAP_DEBUG, false));

  if (!host || !user || !pass) {
    console.error("Missing IMAP_HOST, IMAP_USER, or IMAP_PASS environment variables");
    process.exit(1);
  }

  if (preflightEnabled) {
    debug("running preflight");
    try {
      const preflight = await runImapPreflight(host, port, connectTimeoutMs, secure);
      const tlsDetail = preflight.tlsMs == null ? "TLS=skipped" : `TLS=${preflight.tlsMs}ms`;
      console.error(
        `IMAP preflight OK host=${preflight.host} ip=${preflight.dnsAddress} port=${preflight.port} TCP=${preflight.tcpMs}ms ${tlsDetail}`,
      );
    } catch (err) {
      throw new Error(
        `IMAP preflight failed for ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: connectTimeoutMs,
    greetingTimeout: connectTimeoutMs,
    socketTimeout: socketTimeoutMs,
    logger: false,
  });
  let lastClientError: Error | null = null;
  client.on("error", (err) => {
    if (err instanceof Error) {
      lastClientError = err;
    } else {
      lastClientError = new Error(String(err));
    }
  });

  let connected = false;

  try {
    debug("starting IMAP connect loop");
    let connectedInRetry = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= connectRetries; attempt++) {
      try {
        debug(`connect attempt ${attempt + 1}/${connectRetries + 1}`);
        await client.connect();
        connectedInRetry = true;
        debug("connect succeeded");
        break;
      } catch (err) {
        lastErr = lastClientError ?? err;
        if (attempt < connectRetries) {
          console.error(
            `IMAP connect attempt ${attempt + 1}/${connectRetries + 1} failed: ${
              (lastClientError ?? err) instanceof Error
                ? (lastClientError ?? err).message
                : String(lastClientError ?? err)
            }. Retrying in ${retryDelayMs}ms...`,
          );
          await sleep(retryDelayMs);
        }
      }
    }
    if (!connectedInRetry) {
      throw lastErr;
    }
    connected = true;

    debug("acquiring INBOX lock");
    const lock = await client.getMailboxLock("INBOX");
    debug("INBOX lock acquired");

    try {
      const lastUid = getLastUid();
      debug(`last UID: ${lastUid}`);

      // On first run, avoid scanning the full mailbox if there are years of unseen mail.
      const searchQuery: Record<string, unknown> = { seen: false };
      if (lastUid > 0) {
        searchQuery.uid = `${lastUid + 1}:*`;
      } else {
        const uidNext = client.mailbox?.uidNext ?? 1;
        const floor = Math.max(1, uidNext - initialUidWindow);
        searchQuery.uid = `${floor}:*`;
      }
      debug(`search query: ${JSON.stringify(searchQuery)}`);

      const uids = await client.search(searchQuery, { uid: true });
      debug(`search result count: ${uids.length}`);

      if (!uids || uids.length === 0) {
        const result: CheckResult = { newEmails: 0, emails: [] };
        process.stdout.write(JSON.stringify(result) + "\n");
        return;
      }

      mkdirSync(TMP_DIR, { recursive: true });
      const emails: EmailResult[] = [];
      const processedUids: number[] = [];
      let maxUid = lastUid;

      const uidRange = uids.join(",");
      debug(`fetching UIDs: ${uidRange}`);
      for await (const msg of client.fetch(uidRange, { uid: true, source: true }, { uid: true })) {
        debug(`processing UID: ${msg.uid}`);
        const parsed = await simpleParser(msg.source);

        const sender = parsed.from?.value?.[0]?.address || parsed.from?.text || "unknown";
        const subject = parsed.subject || "(no subject)";
        const body = parsed.text || "";

        const attachments: EmailAttachment[] = [];
        if (parsed.attachments) {
          for (const att of parsed.attachments) {
            const ct = att.contentType || "";
            const isImage = ct.startsWith("image/");
            const isSpreadsheet =
              ct.includes("csv") ||
              ct.includes("excel") ||
              ct.includes("spreadsheet") ||
              ct.includes("officedocument") ||
              (att.filename || "").match(/\.(csv|xlsx|xls)$/i) !== null;
            if (!isImage && !isSpreadsheet) continue;

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
        processedUids.push(msg.uid);

        if (msg.uid > maxUid) maxUid = msg.uid;
      }

      if (processedUids.length > 0) {
        const seenRange = processedUids.join(",");
        debug(`marking seen UIDs: ${seenRange}`);
        await client.messageFlagsAdd({ uid: seenRange }, ["\\Seen"], { uid: true });
      }

      if (maxUid > lastUid) {
        saveLastUid(maxUid);
      }

      const result: CheckResult = { newEmails: emails.length, emails };
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally {
      lock.release();
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(
        `IMAP connection timed out to ${host}:${port} after ${connectRetries + 1} attempt(s). Check host/port reachability and firewall egress.`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    if (connected) {
      await client.logout().catch(() => {
        client.close();
      });
    } else {
      client.close();
    }
  }
}

main().catch((err) => {
  console.error("check-email failed:", err.message || err);
  process.exit(1);
});
