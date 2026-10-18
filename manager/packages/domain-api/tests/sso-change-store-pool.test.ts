// Pool lifecycle of PgSsoChangeStore without a database: CA rotation rebuild decision, TLS verification errors,
// and "missing user / password / CA = not ready, never a connection without TLS" (D-MSSO-11).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditDbConfig } from "../src/config.js";
import { caFingerprint, createPgPool, createPgSsoChangeStore, PgSsoChangeStore } from "../src/store/ssoChangeStore.js";

function fakePool(query: () => Promise<unknown> = async () => ({ rows: [] })) {
  return { query: vi.fn(query), end: vi.fn(async () => undefined) } as unknown as pg.Pool & {
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

describe("PgSsoChangeStore pool rebuild", () => {
  it("rebuilds the pool (ending the old one) when the CA fingerprint changes, not before", async () => {
    const pools: ReturnType<typeof fakePool>[] = [];
    let fp = "1";
    const store = new PgSsoChangeStore(
      () => {
        const p = fakePool();
        pools.push(p);
        return p;
      },
      Date.now,
      () => fp,
    );
    await store.recordEvent({ stage: "denied", actorSub: "u" });
    await store.recordEvent({ stage: "denied", actorSub: "u" });
    expect(pools).toHaveLength(1);
    fp = "2";
    await store.recordEvent({ stage: "denied", actorSub: "u" });
    expect(pools).toHaveLength(2);
    expect(pools[0]?.end).toHaveBeenCalledTimes(1);
    expect(pools[1]?.query).toHaveBeenCalledTimes(1);
  });

  it("discards the pool on a TLS verification error so the next call re-reads the CA", async () => {
    const pools: ReturnType<typeof fakePool>[] = [];
    const store = new PgSsoChangeStore(() => {
      const p = fakePool(
        pools.length === 0 ? () => Promise.reject(Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })) : undefined,
      );
      pools.push(p);
      return p;
    });
    await expect(store.recordEvent({ stage: "denied", actorSub: "u" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(pools[0]?.end).toHaveBeenCalledTimes(1);
    await store.recordEvent({ stage: "denied", actorSub: "u" });
    expect(pools).toHaveLength(2);
  });

  it("keeps the pool on non-TLS errors", async () => {
    const pool = fakePool(() => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" })));
    const store = new PgSsoChangeStore(() => pool);
    await expect(store.recordEvent({ stage: "denied", actorSub: "u" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(pool.end).not.toHaveBeenCalled();
  });
});

describe("CA file mtime fingerprint", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "m3-ca-"));
    dirs.push(d);
    return d;
  };

  it("changes when the CA file mtime changes; undefined when missing", () => {
    const file = path.join(tmp(), "ca.crt");
    expect(caFingerprint(file)).toBeUndefined();
    fs.writeFileSync(file, "ca");
    fs.utimesSync(file, 1_000, 1_000);
    const before = caFingerprint(file);
    fs.utimesSync(file, 2_000, 2_000);
    expect(caFingerprint(file)).not.toBe(before);
  });

  const config = (dir: string, over: Partial<AuditDbConfig> = {}): AuditDbConfig => ({
    host: "manager-db-rw.platform-system.svc.cluster.local",
    port: 5432,
    database: "manager",
    user: "manager_writer",
    passwordFile: path.join(dir, "password"),
    sslCaFile: path.join(dir, "ca.crt"),
    ...over,
  });

  it("missing user, password or CA is 'not ready' (UNAVAILABLE), never a connection", async () => {
    const dir = tmp();
    const connect = vi.spyOn(await import("pg").then((m) => m.default), "Pool");
    // CA and password absent
    expect(() => createPgPool(config(dir))).toThrow();
    fs.writeFileSync(path.join(dir, "password"), "pw\n");
    expect(() => createPgPool(config(dir))).toThrow(); // CA still absent
    fs.writeFileSync(path.join(dir, "ca.crt"), "-----BEGIN CERTIFICATE-----\n");
    expect(() => createPgPool(config(dir, { user: "" }))).toThrow(/MANAGER_DB_USER/);
    fs.writeFileSync(path.join(dir, "password"), "\n");
    expect(() => createPgPool(config(dir))).toThrow(/empty/);
    expect(connect).not.toHaveBeenCalled();

    const store = createPgSsoChangeStore(config(dir, { user: "" }));
    expect(await store.ready()).toBe(false);
    expect(store.status()).toBe("unavailable");
    await expect(store.recordEvent({ stage: "denied", actorSub: "u" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
  });
});
