// Personal import tokens for the laptop folder watcher.
//
// The token is generated in the browser, shown once, and never stored anywhere:
// only its SHA-256 hash goes in the database. So a copy of the database does not
// let anyone import anything, and a lost token can be revoked by deleting one row.
//
// Uses Web Crypto only, so the same code runs in the browser, in Deno (the Edge
// Function) and in Node (the tests and the watcher).

export const TOKEN_PREFIX = 'vr_';

// 32 random bytes, which is far past guessing range.
const TOKEN_BYTES = 32;

const toBase64Url = (bytes) => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A fresh token: "vr_" followed by 32 random bytes in base64url. */
export function newToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + toBase64Url(bytes);
}

/** SHA-256 of the token, lowercase hex. This is the only form ever stored. */
export async function hashToken(token) {
  const data = new TextEncoder().encode(String(token ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Does this look like one of our tokens at all? Used to tell an import token
 * apart from a user's JWT in the Authorization header, before any database work.
 */
export function looksLikeToken(value) {
  return /^vr_[A-Za-z0-9_-]{32,}$/.test(String(value ?? ''));
}

/**
 * Pull the credential out of an Authorization header.
 * Returns { kind: 'token' | 'jwt' | 'none', value }.
 */
export function readAuthorization(header) {
  const raw = String(header ?? '').trim();
  if (!raw) return { kind: 'none', value: '' };
  // "Bearer" with nothing after it is an empty credential, not a credential
  // that happens to be called Bearer.
  if (/^bearer$/i.test(raw)) return { kind: 'none', value: '' };
  const value = /^bearer\s+/i.test(raw) ? raw.replace(/^bearer\s+/i, '').trim() : raw;
  if (!value) return { kind: 'none', value: '' };
  return { kind: looksLikeToken(value) ? 'token' : 'jwt', value };
}

/** The last few characters, for showing which token a row refers to. */
export const tokenHint = (token) => String(token ?? '').slice(-4);
