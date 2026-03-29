/** Compute MD5-like hash of content for change detection.
 *  Uses SHA-256 via SubtleCrypto (available everywhere), truncated to 16 hex chars for compactness.
 *  We don't need cryptographic security, just change detection. */
export async function computeHash(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  return computeHashBinary(encoded.buffer);
}

/** Compute hash for binary content (ArrayBuffer) */
export async function computeHashBinary(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    const byte = hashArray[i];
    if (byte === undefined) {
      break;
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
