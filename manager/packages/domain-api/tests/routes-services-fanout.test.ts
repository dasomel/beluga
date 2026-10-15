import { expect, test, vi } from "vitest";
import { ServiceAdapterRegistry } from "../src/adapters/registry.js";
import { createStubAdapter } from "../src/adapters/stubAdapter.js";
import { createApp } from "../src/app.js";
import { listResponseSchema } from "../src/schema/envelope.js";
import { serviceSchema } from "../src/schema/service.js";
import { services } from "../src/stub-data/services.js";

const responseSchema = listResponseSchema(serviceSchema, "ServiceFanoutResponseTest");

function fixtureAdapters() {
  return services.map((service) => {
    const adapter = createStubAdapter(service);
    return {
      ...adapter,
      getMetadata: vi.fn(adapter.getMetadata),
      getVersion: vi.fn(adapter.getVersion),
      getHealth: vi.fn(adapter.getHealth),
    };
  });
}

function expectCalls(adapter: ReturnType<typeof fixtureAdapters>[number], count: number) {
  expect(adapter.getMetadata).toHaveBeenCalledTimes(count);
  expect(adapter.getVersion).toHaveBeenCalledTimes(count);
  expect(adapter.getHealth).toHaveBeenCalledTimes(count);
}

test("type is selected before fanout; excluded failures produce no calls or warnings", async () => {
  const adapters = fixtureAdapters();
  for (const adapter of adapters.filter((candidate) => candidate.type !== "trino")) {
    adapter.getHealth.mockRejectedValue(new Error("excluded upstream"));
  }
  const response = await createApp(new ServiceAdapterRegistry(adapters)).request("/api/v1/services?type=trino&status=healthy");
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.data.map((service) => service.id)).toEqual(["svc-trino"]);
  expect(body.meta.total).toBe(1);
  expect(body.warnings).toBeUndefined();
  for (const adapter of adapters) expectCalls(adapter, adapter.type === "trino" ? 1 : 0);
});

test("a valid type without registered adapters returns an empty list without calls", async () => {
  const adapters = fixtureAdapters().filter((adapter) => adapter.type !== "trino");
  const response = await createApp(new ServiceAdapterRegistry(adapters)).request("/api/v1/services?type=trino");
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.data).toEqual([]);
  expect(body.meta.total).toBe(0);
  expect(body.warnings).toBeUndefined();
  for (const adapter of adapters) expectCalls(adapter, 0);
});

test("selected failures retain HTTP 200, unknown entries and page warnings", async () => {
  const adapters = fixtureAdapters();
  const selected = adapters.find((adapter) => adapter.type === "trino")!;
  selected.getHealth.mockRejectedValue(new Error("upstream unavailable"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await createApp(new ServiceAdapterRegistry(adapters)).request("/api/v1/services?type=trino&status=unknown");
    expect(response.status).toBe(200);
    const body = responseSchema.parse(await response.json());
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: selected.id, status: "unknown", version: null, staleAfterMs: 0 });
    expect(body.warnings).toEqual([{ code: "UNKNOWN", message: `${selected.name} status is unknown`, serviceId: selected.id }]);
    for (const adapter of adapters) expectCalls(adapter, adapter === selected ? 1 : 0);
  } finally {
    log.mockRestore();
  }
});

test("status alone still fetches every adapter before filtering", async () => {
  const adapters = fixtureAdapters();
  const response = await createApp(new ServiceAdapterRegistry(adapters)).request("/api/v1/services?status=healthy&pageSize=100");
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.data.map((service) => service.id)).toEqual(services.filter((service) => service.status === "healthy").map((service) => service.id));
  for (const adapter of adapters) expectCalls(adapter, 1);
});

test("invalid type is rejected before any adapter calls", async () => {
  const adapters = fixtureAdapters();
  const response = await createApp(new ServiceAdapterRegistry(adapters)).request("/api/v1/services?type=invalid");
  expect(response.status).toBe(400);
  for (const adapter of adapters) expectCalls(adapter, 0);
});
