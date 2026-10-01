import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  AdapterTimeoutError,
  DuplicateAdapterError,
  ServiceAdapterRegistry,
  UnsupportedAdapterVersionError,
} from "../src/adapters/registry.js";
import { createStubAdapter, createStubRegistry } from "../src/adapters/stubAdapter.js";
import type { ServiceAdapter } from "../src/adapters/types.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { serviceSchema } from "../src/schema/service.js";
import { services } from "../src/stub-data/services.js";

const listSchema = listResponseSchema(serviceSchema, "ServiceListResponseAdapterTest");

afterEach(() => {
  vi.restoreAllMocks();
});

function failing(base: ServiceAdapter, method: "getMetadata" | "getVersion" | "getHealth"): ServiceAdapter {
  return { ...base, [method]: async () => { throw new Error("upstream boom at 10.0.0.1"); } };
}

test("스텁 레지스트리는 stub-data를 인터페이스를 통해 그대로(순서 포함) 돌려준다", async () => {
  const listed = await createStubRegistry().listServices();

  expect(listed).toEqual(services);
});

test("getService는 id로 조회하고 없으면 undefined를 반환한다", async () => {
  const registry = createStubRegistry();

  expect((await registry.getService("svc-trino"))?.id).toBe("svc-trino");
  expect(await registry.getService("nope")).toBeUndefined();
});

test("지원하지 않는 계약 버전의 어댑터 등록은 명확한 오류로 거부된다", () => {
  const adapter = { ...createStubAdapter(services[0]!), contractVersion: 99 };

  expect(() => new ServiceAdapterRegistry().register(adapter)).toThrow(UnsupportedAdapterVersionError);
  expect(() => new ServiceAdapterRegistry().register(adapter)).toThrow(
    "Adapter 'svc-trino' declares contract version 99; supported versions: 1",
  );
});

test("같은 id의 어댑터를 중복 등록하면 거부된다", () => {
  const adapter = createStubAdapter(services[0]!);

  expect(() => new ServiceAdapterRegistry([adapter, adapter])).toThrow(DuplicateAdapterError);
});

test.each(["getMetadata", "getVersion", "getHealth"] as const)(
  "%s가 던지면 해당 서비스만 unknown으로 낮아지고 나머지 목록은 유지된다",
  async (method) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [first, second, ...rest] = services.map(createStubAdapter);
    const registry = new ServiceAdapterRegistry([failing(first!, method), second!, ...rest]);

    const listed = await registry.listServices();

    expect(listed).toHaveLength(services.length);
    expect(listed[0]).toMatchObject({ id: "svc-trino", name: "Trino", type: "trino", status: "unknown", version: null });
    expect(() => serviceSchema.parse(listed[0])).not.toThrow();
    expect(listed.slice(1)).toEqual(services.slice(1));
  },
);

test("GET /api/v1/services는 어댑터 하나가 실패해도 200이고 해당 서비스만 unknown + warning이다", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const adapters = services.map(createStubAdapter).map((a) => (a.id === "svc-airflow" ? failing(a, "getHealth") : a));
  const app = createApp(new ServiceAdapterRegistry(adapters));

  const res = await app.request("/api/v1/services?type=airflow");
  expect(res.status).toBe(200);
  const body = listSchema.parse(await res.json());

  expect(body.data).toHaveLength(1);
  expect(body.data[0]?.status).toBe("unknown");
  expect(body.warnings).toEqual([{ code: "UNKNOWN", message: "Airflow status is unknown", serviceId: "svc-airflow" }]);
  // 내부 오류 세부사항은 응답에 노출되지 않는다.
  expect(JSON.stringify(body)).not.toContain("10.0.0.1");

  const all = await app.request("/api/v1/services");
  expect(all.status).toBe(200);
  expect(listSchema.parse(await all.json()).meta.total).toBe(services.length);
});

test("응답이 없는 어댑터는 주입된 deadline 후 unknown으로 낮아지고 나머지는 영향이 없다", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const [first, ...rest] = services.map(createStubAdapter);
  const hanging: ServiceAdapter = { ...first!, getHealth: () => new Promise(() => {}) };
  const registry = new ServiceAdapterRegistry([hanging, ...rest], 20);

  const listed = await registry.listServices();

  expect(listed[0]).toMatchObject({ id: "svc-trino", status: "unknown", endpoint: null });
  expect(listed.slice(1)).toEqual(services.slice(1));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("svc-trino"), expect.any(AdapterTimeoutError));
});

test("동기적으로 던지는 어댑터도 unknown으로 낮아진다", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sync: ServiceAdapter = {
    ...createStubAdapter(services[0]!),
    getVersion: () => {
      throw new Error("sync boom");
    },
  };

  const listed = await new ServiceAdapterRegistry([sync]).listServices();

  expect(listed[0]?.status).toBe("unknown");
});

test("getService도 실패/타임아웃 시 unknown으로 낮추고 신선한 확인 시각을 주장하지 않는다", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const hanging: ServiceAdapter = { ...createStubAdapter(services[0]!), getMetadata: () => new Promise(() => {}) };
  const svc = await new ServiceAdapterRegistry([hanging], 20).getService("svc-trino");

  expect(svc).toMatchObject({ status: "unknown", lastCheckedAt: "1970-01-01T00:00:00.000Z", staleAfterMs: 0 });
  expect(() => serviceSchema.parse(svc)).not.toThrow();
});

test("어댑터가 반환한 여분/충돌 키는 Service에 새지 않고 identity를 덮어쓰지 못한다", async () => {
  const base = createStubAdapter(services[0]!);
  const evil: ServiceAdapter = {
    ...base,
    getMetadata: async () => ({ ...(await base.getMetadata()), id: "svc-evil", name: "Evil", secret: "x" }) as never,
    getHealth: async () => ({ ...(await base.getHealth()), type: "kafka", token: "y" }) as never,
  };

  const svc = await new ServiceAdapterRegistry([evil]).getService("svc-trino");

  expect(svc).toEqual(services[0]);
  expect(Object.keys(svc!)).not.toContain("secret");
  expect(Object.keys(svc!)).not.toContain("token");
});

test("query-context: Trino 어댑터가 실패하면 404가 아니라 503 SERVICE_UNAVAILABLE이다", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const adapters = services.map(createStubAdapter).map((a) => (a.id === "svc-trino" ? failing(a, "getMetadata") : a));
  const app = createApp(new ServiceAdapterRegistry(adapters));

  const res = await app.request("/api/v1/data-assets/asset-table-orders/query-context");
  expect(res.status).toBe(503);
  expect(errorResponseSchema.parse(await res.json()).error.code).toBe("SERVICE_UNAVAILABLE");

  // 알 수 없는 자산은 Trino 상태와 무관하게 여전히 404다.
  const missing = await app.request("/api/v1/data-assets/nope/query-context");
  expect(missing.status).toBe(404);
});
