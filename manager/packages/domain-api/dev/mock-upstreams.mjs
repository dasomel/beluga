// Fake upstreams for local development of the opt-in, read-only Domain API adapters (issue #252).
//
// DUMMY DATA, DUMMY TOKEN. Everything served here is made-up fixture data and the only accepted credential is
// the obviously fake literal `dev-dummy-token` (not a secret). NEVER point this at, or put it in front of, a
// real Flink / Trino / Lakekeeper, and never reuse a real token with it. It proves adapter wiring only
// (URLs, paths, auth header, response parsing); it says nothing about real upstream behaviour.
//
// One process, dependency-free (node:http only), deterministic (no clock, no randomness), GET only (other
// methods -> 405). One port per upstream, because BELUGA_FLINK_REST_URL must be a bare origin:
//   Flink       :8781  GET /overview, /jobs/overview, /jobs/{jid}      (no auth: the Flink adapter sends no token)
//   Trino       :8780  GET /v1/query                                   (Bearer dev-dummy-token, else 401)
//   Lakekeeper  :8782  GET /catalog/v1/config, .../namespaces[/{ns}[/tables[/{t}]]]   (Bearer dev-dummy-token, else 401)
// Flink data reuses the recorded fixtures under packages/domain-api/tests/fixtures/flink-1.20/ (by path, no
// copy). Trino and Lakekeeper data are spec-derived shapes in ./mock-upstreams/*.json, like the unit tests use.
//
// Run: `npm run dev:upstreams` (from manager/). Lives in packages/domain-api/dev/ so the package is self-contained
// (the Docker build copies only this package); tsconfig.build.json compiles src/ only, so dev/ is never shipped. Environment (all optional):
//   MOCK_UPSTREAMS_HOST   default 127.0.0.1 (compose sets 0.0.0.0 inside the container; the port is not published)
//   MOCK_FLINK_PORT / MOCK_TRINO_PORT / MOCK_LAKEKEEPER_PORT   defaults 8781 / 8780 / 8782 (0 = ephemeral)
//   MOCK_UPSTREAMS_TOKEN  default dev-dummy-token
//   MOCK_FLINK_FIXTURES_DIR  default ../tests/fixtures/flink-1.20 relative to this file
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DUMMY_TOKEN = "dev-dummy-token";
const NS_SEP = "\u001F";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function loadFlinkFixtures(dir) {
  const jobs = new Map();
  for (const file of readdirSync(dir).sort()) {
    // `*.synthetic.json` are hand-edited failure/restart variants for unit tests, not part of the happy-path fake.
    if (/^job-.+\.json$/.test(file) && !file.includes(".synthetic.")) {
      const body = readJson(join(dir, file));
      jobs.set(body.jid, body);
    }
  }
  return { overview: readJson(join(dir, "overview.json")), jobsOverview: readJson(join(dir, "jobs-overview.json")), jobs };
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

// Method check first (GET only), then the handler decides about auth and routing.
function guarded(handler, { token } = {}) {
  return (req, res) => {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed (read-only fake upstream)" }, { allow: "GET" });
    let url;
    try {
      url = new URL(req.url ?? "/", "http://mock-upstream.invalid");
    } catch {
      return send(res, 400, { error: "bad request url" });
    }
    if (token !== undefined && req.headers["authorization"] !== `Bearer ${token}`) {
      return send(res, 401, { error: { message: "missing or wrong dummy bearer token", type: "NotAuthorizedException", code: 401 } }, { "www-authenticate": "Bearer" });
    }
    return handler(url, res);
  };
}

function flinkHandler(fixtures) {
  return (url, res) => {
    const { pathname } = url;
    if (pathname === "/overview") return send(res, 200, fixtures.overview);
    if (pathname === "/jobs/overview") return send(res, 200, fixtures.jobsOverview);
    const match = /^\/jobs\/([0-9a-f]{32})$/.exec(pathname);
    const job = match && fixtures.jobs.get(match[1]);
    if (job) return send(res, 200, job);
    return send(res, 404, { errors: ["Not found."] });
  };
}

function trinoHandler(queries) {
  return (url, res) => (url.pathname === "/v1/query" ? send(res, 200, queries) : send(res, 404, { error: "not found" }));
}

// LoadTableResult derived from the compact catalog fixture. No `config` / `storage-credentials` (vended
// credentials) are ever emitted: the adapter must not surface them and the fake has none to give.
function loadTableResult(table) {
  return {
    "metadata-location": `${table.location}/metadata/00001.metadata.json`,
    metadata: {
      "format-version": 2,
      location: table.location,
      "last-updated-ms": table.lastUpdatedMs,
      "current-schema-id": 0,
      schemas: [{ "schema-id": 0, type: "struct", fields: table.columns }],
      "default-spec-id": 0,
      "partition-specs": [
        {
          "spec-id": 0,
          fields: table.partitionBy.map((p, i) => ({
            "source-id": table.columns.find((c) => c.name === p.source).id,
            "field-id": 1000 + i,
            name: `${p.source}_${p.transform}`,
            transform: p.transform,
          })),
        },
      ],
      snapshots: Array.from({ length: table.snapshots }, (_, i) => ({ "snapshot-id": i + 1 })),
      properties: table.properties,
    },
  };
}

function lakekeeperHandler(catalog) {
  const notFound = (res, type, message) => send(res, 404, { error: { message, type, code: 404 } });
  const base = "/catalog/v1";
  const nsKey = (segments) => segments.join(NS_SEP);
  const byKey = new Map(catalog.namespaces.map((ns) => [nsKey(ns.name), ns]));
  return (url, res) => {
    const { pathname } = url;
    if (pathname === `${base}/config`) {
      if (url.searchParams.get("warehouse") !== catalog.warehouse) return notFound(res, "NoSuchWarehouseException", "unknown warehouse");
      return send(res, 200, { defaults: {}, overrides: { prefix: catalog.prefix } });
    }
    const rest = pathname.startsWith(`${base}/${catalog.prefix}/namespaces`) ? pathname.slice(`${base}/${catalog.prefix}/namespaces`.length) : undefined;
    if (rest === undefined) return notFound(res, "NoSuchNamespaceException", "unknown path");
    if (rest === "") {
      const parent = url.searchParams.get("parent");
      const parentSegments = parent ? parent.split(NS_SEP) : [];
      const children = catalog.namespaces
        .map((ns) => ns.name)
        .filter((name) => name.length === parentSegments.length + 1 && parentSegments.every((seg, i) => name[i] === seg));
      return send(res, 200, { namespaces: children });
    }
    const parts = rest.slice(1).split("/");
    let segments;
    try {
      segments = decodeURIComponent(parts[0] ?? "").split(NS_SEP);
    } catch {
      return notFound(res, "NoSuchNamespaceException", "bad namespace");
    }
    const ns = byKey.get(nsKey(segments));
    if (!ns) return notFound(res, "NoSuchNamespaceException", "unknown namespace");
    if (parts.length === 1) return send(res, 200, { namespace: ns.name, properties: {} });
    if (parts[1] === "tables" && parts.length === 2) {
      return send(res, 200, { identifiers: ns.tables.map((t) => ({ namespace: ns.name, name: t.name })) });
    }
    if (parts[1] === "tables" && parts.length === 3) {
      let name;
      try {
        name = decodeURIComponent(parts[2] ?? "");
      } catch {
        return notFound(res, "NoSuchTableException", "bad table");
      }
      const table = ns.tables.find((t) => t.name === name);
      return table ? send(res, 200, loadTableResult(table)) : notFound(res, "NoSuchTableException", "unknown table");
    }
    return notFound(res, "NoSuchTableException", "unknown path");
  };
}

function listen(server, port, host) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen(server.address().port);
    });
  });
}

// Starts the three fake upstreams. Ports default to 0 (ephemeral) so tests never collide; returns the bound ports.
export async function startMockUpstreams(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? DUMMY_TOKEN;
  const flinkDir = resolve(options.flinkFixturesDir ?? join(here, "..", "tests", "fixtures", "flink-1.20"));
  const flink = loadFlinkFixtures(flinkDir);
  const trinoQueries = readJson(join(here, "mock-upstreams", "trino-queries.json"));
  const catalog = readJson(join(here, "mock-upstreams", "lakekeeper-catalog.json"));

  const servers = {
    flink: createServer(guarded(flinkHandler(flink))), // the Flink adapter sends no Authorization header
    trino: createServer(guarded(trinoHandler(trinoQueries), { token })),
    lakekeeper: createServer(guarded(lakekeeperHandler(catalog), { token })),
  };
  const ports = {};
  try {
    ports.flink = await listen(servers.flink, options.flinkPort ?? 0, host);
    ports.trino = await listen(servers.trino, options.trinoPort ?? 0, host);
    ports.lakekeeper = await listen(servers.lakekeeper, options.lakekeeperPort ?? 0, host);
  } catch (error) {
    for (const server of Object.values(servers)) if (server.listening) server.close();
    throw error;
  }
  return {
    host,
    ports,
    close: () =>
      Promise.all(
        Object.values(servers).map(
          (server) =>
            new Promise((done) => {
              server.close(() => done());
              server.closeAllConnections();
            }),
        ),
      ).then(() => undefined),
  };
}

const port = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) throw new Error(`${name} must be a port number`);
  return Number(raw);
};

async function main() {
  const mock = await startMockUpstreams({
    host: process.env["MOCK_UPSTREAMS_HOST"] || "127.0.0.1",
    token: process.env["MOCK_UPSTREAMS_TOKEN"] || DUMMY_TOKEN,
    flinkPort: port("MOCK_FLINK_PORT", 8781),
    trinoPort: port("MOCK_TRINO_PORT", 8780),
    lakekeeperPort: port("MOCK_LAKEKEEPER_PORT", 8782),
    ...(process.env["MOCK_FLINK_FIXTURES_DIR"] ? { flinkFixturesDir: process.env["MOCK_FLINK_FIXTURES_DIR"] } : {}),
  });
  console.log(`mock-upstreams: DUMMY data + DUMMY token, never point at real services (${mock.host})`);
  console.log(`  flink      http://${mock.host}:${mock.ports.flink}   (no auth)`);
  console.log(`  trino      http://${mock.host}:${mock.ports.trino}   (Bearer dummy token required)`);
  console.log(`  lakekeeper http://${mock.host}:${mock.ports.lakekeeper}   (Bearer dummy token required, base path /catalog)`);
  // PID 1 in a container ignores SIGTERM without a handler.
  const stop = () => mock.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`mock-upstreams: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
