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
 * Deterministic classification: tries sender-map first, then keyword match.
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
      return { method: "sender-map", company };
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
