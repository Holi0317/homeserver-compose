const UNIT_NAME_RE = /^[A-Za-z0-9:._\\-]+(?:@[A-Za-z0-9:._\\-]*)?$/;
const MAX_UNIT_NAME_LENGTH = 255;

/**
 * Validate the character and length rules from systemd.unit.
 *
 * Systemd permits ASCII letters, digits, ':', '-', '_', '.', and '\\'.
 * A single '@' separates a template prefix from an optional instance name.
 */
export function isSafeUnitName(value: string): boolean {
  return value !== "." && value !== ".." &&
    value.length <= MAX_UNIT_NAME_LENGTH && UNIT_NAME_RE.test(value);
}

export function assertSafeUnitName(value: string, label: string): void {
  if (!isSafeUnitName(value)) {
    throw new Error(
      `${label} must be a valid systemd unit name no longer than 255 characters`,
    );
  }
}

export async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
