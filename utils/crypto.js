// utils/crypto.js
// AES-256-GCM reversible encryption for payment gateway credentials.
// Distinct from utils/hash.js (one-way): credentials must be decryptable to call provider APIs.
const crypto = require("crypto");

const ALGO    = "aes-256-gcm";
const KEY_LEN = 32; // bytes
const IV_LEN  = 12; // recommended for GCM
const TAG_LEN = 16;

function getMasterKey() {
  const raw = process.env.PAYMENTS_ENCRYPTION_KEY;
  if (!raw) throw new Error("PAYMENTS_ENCRYPTION_KEY env var is required for payment credential encryption");
  // Accept hex (64 chars) or base64 (44 chars for 32 bytes)
  const buf = Buffer.from(raw, raw.length === 64 ? "hex" : "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error("PAYMENTS_ENCRYPTION_KEY must decode to exactly 32 bytes (use 64-char hex or 44-char base64)");
  }
  return buf;
}

/**
 * Encrypts plaintext with AES-256-GCM.
 * Layout: [12 bytes iv][16 bytes auth tag][ciphertext] — all base64-encoded.
 */
function encrypt(text) {
  const key    = getMasterKey();
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * Decrypts a payload produced by encrypt().
 * Throws on any tamper (auth tag mismatch).
 */
function decrypt(payload) {
  const key  = getMasterKey();
  const buf  = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error("Invalid encrypted payload length");
  const iv         = buf.subarray(0, IV_LEN);
  const tag        = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher   = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
}

module.exports = { encrypt, decrypt };