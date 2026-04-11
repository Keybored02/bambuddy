/**
 * Shared NFC utility: UID normalisation, matching, and a module-level flag that
 * lets a consuming component (e.g. AssignSpoolModal) suppress the global
 * WebNfcListener popup while it is handling NFC reads itself.
 */

export function normalizeHexTag(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

function normalizeTagUid(value: string | null | undefined): string {
  const uid = normalizeHexTag(value);
  return uid.length > 16 ? uid.slice(-16) : uid;
}

function isZeroHex(value: string): boolean {
  return value.length > 0 && /^0+$/.test(value);
}

export function uidMatches(
  scannedUid: string | null | undefined,
  storedUid: string | null | undefined,
): boolean {
  const scanned = normalizeTagUid(scannedUid);
  const stored = normalizeTagUid(storedUid);

  if (!scanned || !stored || isZeroHex(scanned) || isZeroHex(stored)) return false;
  if (scanned === stored) return true;
  if (stored.length > scanned.length && stored.endsWith(scanned)) return true;
  if (scanned.length > stored.length && scanned.endsWith(stored)) return true;
  if (scanned.length >= 8 && stored.endsWith(scanned.slice(-8))) return true;
  if (scanned.length === stored.length && scanned.length > 1 && scanned.slice(1) === stored.slice(1)) return true;
  if (scanned.length === 8 && stored.length >= 8 && scanned.slice(1) === stored.slice(0, 8).slice(1)) return true;

  return false;
}

/**
 * When > 0, the global WebNfcListener modal is suppressed.
 * Components that handle NFC reads themselves should increment on mount / open
 * and decrement on unmount / close.
 */
let nfcModalSuppressCount = 0;

export function suppressNfcModal(): void {
  nfcModalSuppressCount++;
}

export function unsuppressNfcModal(): void {
  nfcModalSuppressCount = Math.max(0, nfcModalSuppressCount - 1);
}

export function isNfcModalSuppressed(): boolean {
  return nfcModalSuppressCount > 0;
}
