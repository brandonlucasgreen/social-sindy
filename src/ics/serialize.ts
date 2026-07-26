/**
 * Low-level iCalendar (RFC 5545) serialization primitives.
 *
 * These are the parts that quietly break calendar feeds: octet-accurate line
 * folding, TEXT escaping, and UTC timestamp formatting. Kept pure and separate
 * so they can be tested without a Worker or a Buffer account.
 */

/** RFC 5545 §3.1: lines SHOULD NOT be longer than 75 octets, excluding CRLF. */
const MAX_OCTETS = 75;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Escapes a value for an iCalendar TEXT property (RFC 5545 §3.3.11).
 *
 * Order matters: backslashes must be escaped before the characters whose
 * escapes introduce new backslashes.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // Control characters other than the newlines handled above are not valid
    // in a TEXT value; drop them rather than emit a feed clients may reject.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * Folds a single content line to the 75-octet limit.
 *
 * Two subtleties the naive `slice(0, 75)` implementation gets wrong:
 *  1. The limit is octets of UTF-8, not JavaScript characters, so any non-ASCII
 *     content (emoji in post text, accented channel names) folds too late.
 *  2. A fold must not split a multi-byte character, or clients render mojibake.
 *
 * Continuation lines begin with a single space, which itself counts toward the
 * limit, so they carry at most 74 octets of payload.
 */
export function foldLine(line: string): string {
  const bytes = encoder.encode(line);
  if (bytes.length <= MAX_OCTETS) return line;

  const parts: string[] = [];
  let offset = 0;
  let isFirst = true;

  while (offset < bytes.length) {
    const budget = isFirst ? MAX_OCTETS : MAX_OCTETS - 1;
    let end = Math.min(offset + budget, bytes.length);

    // Walk back off any UTF-8 continuation byte (0b10xxxxxx) so we always cut
    // on a character boundary.
    if (end < bytes.length) {
      while (end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
    }

    // Defensive: a single character wider than the remaining budget would make
    // no progress. Emit it whole and overrun the soft limit rather than hang.
    if (end === offset) {
      end = Math.min(offset + budget, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
    }

    const chunk = decoder.decode(bytes.subarray(offset, end));
    parts.push(isFirst ? chunk : ` ${chunk}`);
    offset = end;
    isFirst = false;
  }

  return parts.join('\r\n');
}

/** Formats a Date as an RFC 5545 UTC date-time, e.g. `20260802T130000Z`. */
export function formatUtc(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Formats whole minutes as an RFC 5545 duration, preferring the largest tidy
 * unit so feeds advertise `PT1H` rather than `PT60M`.
 */
export function formatDuration(minutes: number): string {
  const total = Math.max(1, Math.round(minutes));
  if (total % 1440 === 0) return `P${total / 1440}D`;
  if (total % 60 === 0) return `PT${total / 60}H`;
  return `PT${total}M`;
}

/** Accumulates content lines and emits a CRLF-delimited, folded document. */
export class LineWriter {
  private readonly lines: string[] = [];

  /** Adds a property line. Values are emitted as-is; escape TEXT beforehand. */
  add(name: string, value: string): void {
    this.lines.push(`${name}:${value}`);
  }

  /** Adds a property line that already includes its own parameters. */
  addRaw(line: string): void {
    this.lines.push(line);
  }

  toString(): string {
    // A trailing CRLF terminates the final content line, per RFC 5545 §3.1.
    return `${this.lines.map(foldLine).join('\r\n')}\r\n`;
  }
}
