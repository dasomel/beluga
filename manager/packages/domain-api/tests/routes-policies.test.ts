import { expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { errorResponseSchema, listResponseSchema } from "../src/schema/envelope.js";
import { policyProjectionSchema } from "../src/schema/policy.js";
import { policies } from "../src/stub-data/policies.js";

const responseSchema = listResponseSchema(policyProjectionSchema, "PolicyListResponseTest");

test("policy list returns the paginated read-only projection", async () => {
  const response = await createApp().request("/api/v1/policies?pageSize=100");
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());

  expect(body.data).toHaveLength(policies.length);
  expect(body.meta.total).toBe(policies.length);

  const policy = body.data[0];
  expect(policy).toBeDefined();
  expect(policy?.id).toBe("beluga-platform-policy");
  expect(policy?.sourceFile).toBe("packages/domain-api/tests/fixtures/platform-policy.yaml");

  // Roles and groups
  const roleNames = policy?.roles.map((r) => r.name);
  expect(roleNames).toContain("admins");
  expect(roleNames).toContain("engineers");
  expect(roleNames).toContain("analysts");

  // Read-only vs mutating classification
  const analystRole = policy?.roles.find((r) => r.name === "analysts");
  expect(analystRole).toBeDefined();
  expect(analystRole?.permissions.length).toBeGreaterThan(0);
  // All analyst permissions in our policy are read-only
  expect(analystRole?.permissions.every((p) => p.accessType === "read-only")).toBe(true);

  const engineerRole = policy?.roles.find((r) => r.name === "engineers");
  expect(engineerRole).toBeDefined();
  const engineerMutating = engineerRole?.permissions.filter((p) => p.accessType === "mutating");
  const engineerReadOnly = engineerRole?.permissions.filter((p) => p.accessType === "read-only");
  expect(engineerMutating?.length).toBeGreaterThan(0);
  expect(engineerReadOnly?.length).toBeGreaterThan(0);

  // Compiled artefact metadata (target, contentHash, lineCount) — NOT raw compiled text
  expect(policy?.artefacts).toHaveLength(3);
  const targets = policy?.artefacts.map((a) => a.target);
  expect(targets).toEqual(["trino-rego", "postgres-grant", "keycloak-mapper"]);

  for (const artefact of policy?.artefacts ?? []) {
    expect(artefact.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artefact.lineCount).toBeGreaterThan(0);
    // Explicitly verify raw code is NOT exposed
    expect("code" in artefact).toBe(false);
    expect("raw" in artefact).toBe(false);
    expect("content" in artefact).toBe(false);
  }
});

test("policy list supports pagination and filtering by role", async () => {
  const app = createApp();

  // Filter by matching role
  const filtered = responseSchema.parse(
    await (await app.request("/api/v1/policies?role=analysts")).json(),
  );
  expect(filtered.data).toHaveLength(1);
  expect(filtered.meta.total).toBe(1);

  // Filter by non-existent role returns empty list (empty case)
  const emptyRes = await app.request("/api/v1/policies?role=non-existent-role");
  expect(emptyRes.status).toBe(200);
  const emptyBody = responseSchema.parse(await emptyRes.json());
  expect(emptyBody.data).toEqual([]);
  expect(emptyBody.meta.total).toBe(0);

  // Page beyond total
  const beyond = responseSchema.parse(
    await (await app.request("/api/v1/policies?page=99&pageSize=10")).json(),
  );
  expect(beyond.data).toEqual([]);
  expect(beyond.meta).toMatchObject({ total: policies.length, page: 99, pageSize: 10 });
});

test("policy query rejects invalid input with 400 VALIDATION_ERROR", async () => {
  const app = createApp();
  const invalidPage = await app.request("/api/v1/policies?page=0");
  expect(invalidPage.status).toBe(400);
  const errBody = errorResponseSchema.parse(await invalidPage.json());
  expect(errBody.error.code).toBe("VALIDATION_ERROR");

  const invalidPageSize = await app.request("/api/v1/policies?pageSize=500");
  expect(invalidPageSize.status).toBe(400);
});

test("policy detail returns policy by id and 404 for unknown id", async () => {
  const app = createApp();

  // Normal case
  const foundRes = await app.request("/api/v1/policies/beluga-platform-policy");
  expect(foundRes.status).toBe(200);
  const found = policyProjectionSchema.parse(await foundRes.json());
  expect(found.id).toBe("beluga-platform-policy");
  expect(found.name).toBe("Beluga Platform Policy");

  // Not-found case
  const missingRes = await app.request("/api/v1/policies/non-existent-policy");
  expect(missingRes.status).toBe(404);
  const errBody = errorResponseSchema.parse(await missingRes.json());
  expect(errBody.error.code).toBe("NOT_FOUND");
  expect(errBody.error.message).toContain("non-existent-policy");
});

test("policy endpoint is read-only and does not expose mutating operations", async () => {
  const app = createApp();
  const doc = (await (await app.request("/api/v1/openapi.json")).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };

  expect(Object.keys(doc.paths["/api/v1/policies"] ?? {})).toEqual(["get"]);
  expect(Object.keys(doc.paths["/api/v1/policies/{id}"] ?? {})).toEqual(["get"]);
});
