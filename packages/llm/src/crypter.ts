// Credential encryption seam (FEAT-01-07, ADR-11). Ported interface from Vault Operator
// src/core/security/providerCredentialCrypto.ts. Stigmergy ships the interface plus a noop
// passthrough in the MVP; a real encrypting impl (Electron safeStorage or node:crypto) lands
// with the provider config (FEAT-01-07 Phase B, SC-07).

/** The host-agnostic credential crypter contract. Implementations: Electron safeStorage,
 * node:crypto, or the noop passthrough below. */
export interface SettingsCrypter {
  isEncrypted(value: string): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

/** Passthrough crypter: stores credentials in plaintext. The MVP/CLI default; callers that
 * use it must warn the user and restrict file permissions (ADR-11 CLI plaintext fallback). */
export const noopCrypter: SettingsCrypter = {
  isEncrypted: () => false,
  encrypt: (v) => v,
  decrypt: (v) => v,
}

/** Encrypt the named credential fields of a record in place. Skips empty or already-encrypted
 * values; idempotent. Mirrors the Vault Operator in-place walker, generalized over a record. */
export function encryptCredentialsInPlace(
  obj: Record<string, unknown>,
  keys: readonly string[],
  crypter: SettingsCrypter,
): void {
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val && !crypter.isEncrypted(val)) {
      obj[key] = crypter.encrypt(val)
    }
  }
}

/** Decrypt the named credential fields in place. Tolerates already-plaintext values. */
export function decryptCredentialsInPlace(
  obj: Record<string, unknown>,
  keys: readonly string[],
  crypter: SettingsCrypter,
): void {
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val) {
      obj[key] = crypter.decrypt(val)
    }
  }
}
