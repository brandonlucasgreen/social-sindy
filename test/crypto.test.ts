import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  fingerprintSecret,
  generateEncryptionKey,
  openSecret,
  randomId,
  randomToken,
  sealSecret,
} from '../src/crypto.js';

const KEY = generateEncryptionKey();
const API_KEY = '1/abcdef0123456789-a-realistic-looking-buffer-key';

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe('sealSecret / openSecret', () => {
  it('round-trips a secret', async () => {
    const sealed = await sealSecret(API_KEY, KEY);
    expect(await openSecret(sealed, KEY)).toBe(API_KEY);
  });

  it('does not leak the plaintext into the stored fields', async () => {
    const sealed = await sealSecret(API_KEY, KEY);
    expect(sealed.ciphertext).not.toContain(API_KEY);
    expect(JSON.stringify(sealed)).not.toContain('abcdef');
  });

  it('uses a fresh nonce, so the same secret never encrypts identically', async () => {
    const a = await sealSecret(API_KEY, KEY);
    const b = await sealSecret(API_KEY, KEY);

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('round-trips non-ASCII secrets', async () => {
    const sealed = await sealSecret('clé—🔑', KEY);
    expect(await openSecret(sealed, KEY)).toBe('clé—🔑');
  });

  it('fails rather than returning garbage under the wrong key', async () => {
    const sealed = await sealSecret(API_KEY, KEY);
    await expect(openSecret(sealed, generateEncryptionKey())).rejects.toThrow();
  });

  it('rejects tampered ciphertext, because GCM authenticates it', async () => {
    const sealed = await sealSecret(API_KEY, KEY);
    const bytes = base64ToBytes(sealed.ciphertext);
    bytes[0] = bytes[0]! ^ 0xff;

    await expect(
      openSecret({ ciphertext: bytesToBase64(bytes), iv: sealed.iv }, KEY),
    ).rejects.toThrow();
  });

  it('rejects a key that is not 32 bytes, with an actionable message', async () => {
    await expect(sealSecret(API_KEY, bytesToBase64(new Uint8Array(16)))).rejects.toThrow(
      /32 bytes/,
    );
  });
});

describe('fingerprintSecret', () => {
  it('is stable and does not reveal the secret', async () => {
    const digest = await fingerprintSecret(API_KEY);

    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(digest).toBe(await fingerprintSecret(API_KEY));
    expect(digest).not.toBe(await fingerprintSecret(`${API_KEY}x`));
  });
});

describe('token generation', () => {
  it('produces URL-safe tokens with no padding', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => randomToken()));
    expect(tokens.size).toBe(500);
  });

  it('produces at least 256 bits of entropy by default', () => {
    // The feed token is the only thing protecting a public feed URL.
    const token = randomToken();
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');

    expect(base64ToBytes(base64).length).toBe(32);
  });

  it('prefixes ids for readability', () => {
    expect(randomId('cal')).toMatch(/^cal_[A-Za-z0-9_-]+$/);
  });

  it('generates a 32-byte encryption key', () => {
    expect(base64ToBytes(generateEncryptionKey()).length).toBe(32);
  });
});
