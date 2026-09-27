import { chmod } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";
import { readJsonFile, writeJsonFileAtomic } from "../store/json-file.ts";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface VapidDetails extends VapidKeys {
  /** `https://<hostname>`, or `mailto:pi-code@localhost` when the hostname is local. */
  subject: string;
}

export const VAPID_FILE = "vapid.json";

function isKeys(value: unknown): value is VapidKeys {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.publicKey === "string" &&
    v.publicKey.length > 0 &&
    typeof v.privateKey === "string" &&
    v.privateKey.length > 0
  );
}

/** The VAPID `sub` claim for a hostname. */
export function vapidSubject(hostname: string): string {
  return hostname === "localhost" || !hostname.includes(".")
    ? "mailto:pi-code@localhost"
    : `https://${hostname}`;
}

/**
 * Loads the VAPID keys from `<dataDir>/vapid.json`, generating and saving them (mode `0600`)
 * on first run. A missing or unreadable file yields new keys, which invalidates existing
 * subscriptions (the browser re-subscribes with the new public key).
 */
export async function loadVapidDetails(dataDir: string, hostname: string): Promise<VapidDetails> {
  const path = join(dataDir, VAPID_FILE);
  let stored: unknown;
  try {
    stored = await readJsonFile(path);
  } catch (e) {
    console.warn(
      `[push] ${path} is unreadable, generating new VAPID keys: ${(e as Error).message}`,
    );
  }
  let keys: VapidKeys;
  if (isKeys(stored)) {
    keys = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    await chmod(path, 0o600).catch(() => {});
  } else {
    const generated = webpush.generateVAPIDKeys();
    keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    await writeJsonFileAtomic(path, keys);
  }
  return { ...keys, subject: vapidSubject(hostname) };
}
