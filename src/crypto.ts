/**
 * Secret handling: envelope encryption for stored Buffer API keys, plus the
 * random token generation used for session IDs and public feed URLs.
 *
 * A stored Buffer API key can post to every social account its owner has
 * connected, so it is encrypted at rest with AES-256-GCM under a key held only
 * in Worker secrets, and never logged or returned in a response body.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** AES-GCM standard nonce length. A fresh nonce is generated per encryption. */
const IV_BYTES = 12;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** URL-safe random token, for values that appear in a URL or a cookie. */
export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(16)}`;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM, got ${raw.length}`,
    );
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export interface SealedSecret {
  ciphertext: string;
  iv: string;
}

export async function sealSecret(plaintext: string, base64Key: string): Promise<SealedSecret> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext) as BufferSource,
  );

  return { ciphertext: bytesToBase64(new Uint8Array(sealed)), iv: bytesToBase64(iv) };
}

export async function openSecret(sealed: SealedSecret, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  // AES-GCM authenticates the ciphertext, so tampering or a wrong key throws
  // here rather than yielding garbage plaintext.
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(sealed.iv) as BufferSource },
    key,
    base64ToBytes(sealed.ciphertext) as BufferSource,
  );

  return decoder.decode(plaintext);
}

/**
 * Short, non-reversible digest of a secret.
 *
 * Lets us tell whether a re-submitted API key differs from the stored one
 * without decrypting it, and gives us something safe to show in the UI.
 */
export async function fingerprintSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret) as BufferSource);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Generates a 32-byte AES key, for operators setting up ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}
