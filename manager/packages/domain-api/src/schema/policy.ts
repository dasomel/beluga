import { z } from "@hono/zod-openapi";
import { paginationQuerySchema } from "./query.js";

export const policyPermissionSchema = z
  .object({
    resource: z.string().min(1).openapi({ example: "lake.customers" }),
    catalog: z.string().min(1).openapi({ example: "iceberg" }),
    engine: z.enum(["trino", "postgres"]).openapi({ example: "trino" }),
    operation: z.string().min(1).openapi({ example: "select" }),
    accessType: z.enum(["read-only", "mutating"]).openapi({ example: "read-only" }),
    columnMask: z.record(z.string(), z.string()).optional().openapi({ example: { email: "hash" } }),
    rowFilter: z.string().optional().openapi({ example: "region = 'KR'" }),
    allowUnmasked: z.boolean().optional().openapi({ example: false }),
  })
  .openapi("PolicyPermission");

export const policyRoleSummarySchema = z
  .object({
    name: z.string().min(1).openapi({ example: "analysts" }),
    includes: z.array(z.string()).openapi({ example: [] }),
    permissions: z.array(policyPermissionSchema),
  })
  .openapi("PolicyRoleSummary");

export const policyGroupSummarySchema = z
  .object({
    name: z.string().min(1).openapi({ example: "analysts" }),
    roles: z.array(z.string()).min(1).openapi({ example: ["analysts"] }),
  })
  .openapi("PolicyGroupSummary");

export const policyArtefactMetadataSchema = z
  .object({
    target: z.enum(["trino-rego", "postgres-grant", "keycloak-mapper"]).openapi({ example: "trino-rego" }),
    contentHash: z.string().min(1).openapi({ example: "sha256:1a2b3c..." }),
    lineCount: z.number().int().nonnegative().openapi({ example: 42 }),
  })
  .openapi("PolicyArtefactMetadata");

export const policyProjectionSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "beluga-platform-policy" }),
    name: z.string().min(1).openapi({ example: "Beluga Platform Policy" }),
    version: z.string().min(1).openapi({ example: "0.1.0" }),
    description: z.string().optional().openapi({ example: "Declarative platform security policy" }),
    sourceFile: z.string().min(1).openapi({ example: "beluga/policies/platform-policy.yaml" }),
    evaluatedAt: z.string().datetime().openapi({ example: "2026-09-28T09:00:00.000Z" }),
    roles: z.array(policyRoleSummarySchema),
    groups: z.array(policyGroupSummarySchema),
    artefacts: z.array(policyArtefactMetadataSchema),
  })
  .openapi("PolicyProjection");

export const policyListQuerySchema = paginationQuerySchema.extend({
  role: z.string().min(1).optional().openapi({ example: "analysts" }),
});

export type PolicyPermission = z.infer<typeof policyPermissionSchema>;
export type PolicyRoleSummary = z.infer<typeof policyRoleSummarySchema>;
export type PolicyGroupSummary = z.infer<typeof policyGroupSummarySchema>;
export type PolicyArtefactMetadata = z.infer<typeof policyArtefactMetadataSchema>;
export type PolicyProjection = z.infer<typeof policyProjectionSchema>;
export type PolicyListQuery = z.infer<typeof policyListQuerySchema>;
