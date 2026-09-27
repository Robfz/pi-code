import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "../errors.ts";
import { readJsonFile, writeJsonFileAtomic } from "../store/json-file.ts";

/** A browser push subscription as stored (the fields `web-push` needs). */
export interface StoredSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  /** ISO 8601. */
  createdAt: string;
}

export const SUBSCRIPTIONS_FILE = "push-subscriptions.json";

/** Validates a browser `PushSubscriptionJSON` body; throws `invalid_body`. */
export function parseSubscription(value: unknown): Omit<StoredSubscription, "createdAt"> {
  const invalid = (why: string) =>
    new ApiError("invalid_body", `invalid push subscription: ${why}`);
  if (typeof value !== "object" || value === null) throw invalid("expected an object");
  const v = value as Record<string, unknown>;
  if (typeof v.endpoint !== "string") throw invalid("endpoint must be a string");
  let url: URL;
  try {
    url = new URL(v.endpoint);
  } catch {
    throw invalid("endpoint must be a URL");
  }
  if (url.protocol !== "https:") throw invalid("endpoint must be https");
  const keys = v.keys as Record<string, unknown> | undefined;
  if (
    typeof keys !== "object" ||
    keys === null ||
    typeof keys.p256dh !== "string" ||
    keys.p256dh === "" ||
    typeof keys.auth !== "string" ||
    keys.auth === ""
  ) {
    throw invalid("keys.p256dh and keys.auth are required");
  }
  const exp = v.expirationTime;
  if (exp !== undefined && exp !== null && typeof exp !== "number") {
    throw invalid("expirationTime must be a number or null");
  }
  return {
    endpoint: v.endpoint,
    ...(exp !== undefined ? { expirationTime: exp } : {}),
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

function isStored(value: unknown): value is StoredSubscription {
  try {
    parseSubscription(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Push subscriptions keyed by endpoint, persisted to `<dataDir>/push-subscriptions.json`
 * (atomic writes, serialized, mode `0600`: endpoints and keys let anyone push to the devices).
 * Loaded lazily on first use; loading also tightens an existing file to `0600`.
 */
export class SubscriptionStore {
  private readonly path: string;
  private subs: Map<string, StoredSubscription> | undefined;
  private loading: Promise<Map<string, StoredSubscription>> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, SUBSCRIPTIONS_FILE);
  }

  async list(): Promise<StoredSubscription[]> {
    return [...(await this.load()).values()];
  }

  async add(sub: Omit<StoredSubscription, "createdAt">): Promise<void> {
    const subs = await this.load();
    const existing = subs.get(sub.endpoint);
    subs.set(sub.endpoint, { ...sub, createdAt: existing?.createdAt ?? new Date().toISOString() });
    await this.save();
  }

  /** Removes a subscription; resolves `false` when it wasn't stored. */
  async remove(endpoint: string): Promise<boolean> {
    const subs = await this.load();
    if (!subs.delete(endpoint)) return false;
    await this.save();
    return true;
  }

  private load(): Promise<Map<string, StoredSubscription>> {
    if (this.subs) return Promise.resolve(this.subs);
    this.loading ??= (async () => {
      const subs = new Map<string, StoredSubscription>();
      try {
        const data = await readJsonFile(this.path);
        if (typeof data === "object" && data !== null && !Array.isArray(data)) {
          for (const value of Object.values(data)) {
            if (isStored(value)) subs.set(value.endpoint, value);
          }
        }
      } catch (e) {
        console.warn(`[push] ignoring unreadable ${this.path}: ${(e as Error).message}`);
      }
      await chmod(this.path, 0o600).catch(() => {}); // ENOENT: nothing written yet
      this.subs = subs;
      return subs;
    })();
    return this.loading;
  }

  private save(): Promise<void> {
    const snapshot = Object.fromEntries(this.subs ?? []);
    const run = this.writes.then(() => writeJsonFileAtomic(this.path, snapshot, 0o600));
    this.writes = run.catch((e) => {
      console.error(`[push] failed to save ${this.path}:`, e);
    });
    return run;
  }
}
