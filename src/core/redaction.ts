import { sha256 } from "./json.js";

/**
 * Command output is evidence, and evidence outlives the run.
 *
 * A Verify command's output reaches the manifest, the manifest reaches the base
 * branch through the accept squash, and the base branch is pushed. Anything a
 * test prints is therefore permanent and, on a public repository, published. So
 * output is never stored raw: it is redacted, bounded, and reduced to a digest
 * that still proves which bytes were produced.
 */

export const REDACTED = "[redacted]";

/** How much of the tail survives into the manifest. */
export const EVIDENCE_EXCERPT_BYTES = 2_048;

/**
 * Patterns for credentials that appear in ordinary build output.
 *
 * This is a net, not a guarantee — no pattern list catches every secret, which
 * is exactly why the excerpt is also bounded and the full output stays out of
 * Git. Ordered longest-context first so a specific match wins over a generic one.
 */
interface SecretPattern {
  pattern: RegExp;
  /** How the match is rewritten. Each pattern owns its own replacement, rather
   * than sharing one that guesses from the shape of the capture groups. */
  replace: string | ((match: string, ...groups: string[]) => string);
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // PEM private key blocks, including their body.
  { pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, replace: REDACTED },
  // Credentials embedded in a URL: scheme://user:secret@host — the scheme and
  // user survive so the line still says what was being reached.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, replace: (_match, prefix) => `${prefix}:${REDACTED}@` },
  // GitHub tokens, in every documented prefix.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: REDACTED },
  // AWS access key ids.
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  // JSON Web Tokens.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: REDACTED },
  // Authorization headers, keeping the scheme.
  { pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: (_match, scheme) => `${scheme} ${REDACTED}` },
  // Slack, Stripe, and Google style keys.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
  { pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  // Anything self-declaring as a credential, in shell, env, JSON, or YAML form.
  // The key may carry a prefix, as in DB_PASSWORD or service.api-key, so there
  // is deliberately no word boundary before it. The key survives; the value does not.
  {
    pattern: /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    replace: (_match, key) => `${key}${REDACTED}`,
  },
];

export interface RedactionResult {
  text: string;
  /** How many substitutions were made; surfaced so a reader knows to be careful. */
  count: number;
}

export function redact(value: string): RedactionResult {
  let count = 0;
  let text = value;
  for (const { pattern, replace } of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args: unknown[]) => {
      count += 1;
      return typeof replace === "string" ? replace : replace(...(args as [string, ...string[]]));
    });
  }
  return { text, count };
}

export function boundedTail(value: string, limit = EVIDENCE_EXCERPT_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return { text: value, truncated: false };
  const tail = bytes.subarray(bytes.byteLength - limit).toString("utf8");
  const newline = tail.indexOf("\n");
  // Drop a leading partial line, but only when doing so keeps most of the tail.
  const trimmed = newline >= 0 && newline < limit / 4 ? tail.slice(newline + 1) : tail;
  return { text: trimmed, truncated: true };
}

/**
 * What the manifest keeps about one stream of command output.
 *
 * `digest` is over the original bytes, so the record still identifies exactly
 * what was produced even though the bytes themselves were never stored.
 */
export interface OutputEvidence {
  digest: string;
  bytes: number;
  truncated: boolean;
  redactions: number;
  /** Present only when the repository opted in to persisting an excerpt. */
  excerpt?: string;
}

/**
 * What the manifest records about one stream of output.
 *
 * By default it records **no output at all** — only the digest, the byte count,
 * and how many credential shapes were found. That is the conservative default a
 * public repository needs: redaction is a pattern net, and a secret in a shape
 * nobody anticipated would otherwise be committed to the base branch forever.
 *
 * A repository that wants a diagnostic excerpt opts in per repository. The full
 * output is always available in the disposable runtime either way.
 */
export function outputEvidence(value: string, options: { excerpt?: boolean; limit?: number } = {}): OutputEvidence {
  const { text, truncated } = boundedTail(value, options.limit ?? EVIDENCE_EXCERPT_BYTES);
  const redacted = redact(text);
  return {
    digest: sha256(value),
    bytes: Buffer.byteLength(value, "utf8"),
    truncated,
    redactions: redacted.count,
    ...(options.excerpt === true ? { excerpt: redacted.text } : {}),
  };
}
