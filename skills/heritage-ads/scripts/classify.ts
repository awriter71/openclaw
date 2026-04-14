import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFS = join(__dirname, "..", "references");

type SenderMap = Record<string, string>;
type CompaniesConfig = { companies: string[] };

export type ClassifyResult =
  | { method: "sender-map"; company: string }
  | { method: "keyword"; company: string }
  | { method: "none"; company: null };

let _senderMap: SenderMap | undefined;
let _companies: CompaniesConfig | undefined;

function loadSenderMap(): SenderMap {
  if (!_senderMap) {
    _senderMap = JSON.parse(readFileSync(join(REFS, "sender-map.json"), "utf-8"));
  }
  return _senderMap;
}

function loadCompanies(): CompaniesConfig {
  if (!_companies) {
    _companies = JSON.parse(readFileSync(join(REFS, "companies.json"), "utf-8"));
  }
  return _companies;
}

export function getCompanyList(): string[] {
  return loadCompanies().companies;
}

/**
 * Extract the original sender from a forwarded email body.
 * Looks for patterns like:
 *   - "---------- Forwarded message ----------\nFrom: Name <email@example.com>"
 *   - "Begin forwarded message:\n...\nFrom: Name <email@example.com>"
 *   - "From: email@example.com" near the top of a forwarded block
 * Returns the extracted email address, or null if not found.
 */
function extractForwardedSender(subject: string, body: string): string | null {
  const isForwarded =
    /^Fwd?:/i.test(subject) ||
    body.includes("Forwarded message") ||
    body.includes("Begin forwarded message") ||
    body.includes("forwarded message");

  if (!isForwarded) return null;

  const fromPatterns = [
    /From:\s*[^<]*<([^>]+@[^>]+)>/im,
    /From:\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/im,
  ];

  for (const pattern of fromPatterns) {
    const match = body.match(pattern);
    if (match?.[1]) return match[1].toLowerCase().trim();
  }

  return null;
}

/**
 * Deterministic classification: tries sender-map first, then forwarded sender,
 * then keyword match.
 * Returns the method used and company name, or `{ method: "none" }` if no match.
 */
export function classifyEmail(sender: string, subject: string, body: string): ClassifyResult {
  const senderMap = loadSenderMap();
  const normalizedSender = sender.toLowerCase().trim();

  // Method A.1: exact sender match
  for (const [email, company] of Object.entries(senderMap)) {
    if (
      normalizedSender === email.toLowerCase() ||
      normalizedSender.includes(email.toLowerCase())
    ) {
      // Check if this is a forwarded email — the original sender may map
      // to a different company than the forwarder.
      const forwardedSender = extractForwardedSender(subject, body);
      if (forwardedSender && forwardedSender !== normalizedSender) {
        for (const [fwdEmail, fwdCompany] of Object.entries(senderMap)) {
          if (forwardedSender === fwdEmail.toLowerCase()) {
            return { method: "sender-map", company: fwdCompany };
          }
        }
        // Forwarded sender not in sender-map — fall through to keyword match
      } else {
        return { method: "sender-map", company };
      }
    }
  }

  // Method A.1b: check forwarded sender even if outer sender wasn't in the map
  const forwardedSender = extractForwardedSender(subject, body);
  if (forwardedSender) {
    for (const [email, company] of Object.entries(senderMap)) {
      if (forwardedSender === email.toLowerCase()) {
        return { method: "sender-map", company };
      }
    }
  }

  // Method A.2: company name keyword in subject or body
  const companies = loadCompanies().companies;
  const searchText = `${subject} ${body}`.toLowerCase();

  for (const company of companies) {
    if (searchText.includes(company.toLowerCase())) {
      return { method: "keyword", company };
    }
  }

  return { method: "none", company: null };
}

// CLI mode: read JSON from stdin, output classification result
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = readFileSync(0, "utf-8");
  const { sender, subject, body } = JSON.parse(input);
  const result = classifyEmail(sender, subject, body);
  process.stdout.write(JSON.stringify(result) + "\n");
}
