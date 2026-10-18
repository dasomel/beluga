import { z } from "@hono/zod-openapi";

// D-MSSO-8/9: request and response shapes of the SSO change-request routes.
export const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{32}$/;
export const MAX_REASON_LENGTH = 500;

// allowedGroups is intentionally a list of unknowns here: "strings only, no duplicates, known groups..." are
// D-MSSO-8 invariants answered with 422 and a field-level message by the edit engine, not a generic 400.
export const ssoChangeRequestBodySchema = z
  .object({
    endpoint: z.string().min(1).max(64).openapi({ example: "flink" }),
    allowedGroups: z.array(z.unknown()).max(64).openapi({ type: "array", items: { type: "string" }, example: ["admins", "engineers"] }),
    reason: z.string().max(MAX_REASON_LENGTH).optional().openapi({ example: "Give analysts access to the Flink UI" }),
    baseBlobSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional()
      .openapi({ description: "Required on submit: the baseBlobSha returned by the preview." }),
  })
  .strict()
  .openapi("SsoChangeRequestBody");

const groupList = z.array(z.string()).openapi({ example: ["admins", "engineers"] });

export const ssoChangePreviewSchema = z
  .object({
    endpoint: z.string(),
    patch: z.object({ allowedGroups: groupList }),
    before: groupList.nullable().openapi({ description: "null = the field is absent today (no group check)." }),
    after: groupList,
    baseBlobSha: z.string(),
    sourceCommitSha: z.string(),
    diff: z.string(),
  })
  .openapi("SsoChangePreview");

export const changeStageSchema = z
  .enum(["submitted", "pr_open", "unknown_recovering", "merged", "applied", "rejected", "failed"])
  .openapi("SsoChangeStage");

export const ssoChangeRecordSchema = z
  .object({
    id: z.string().uuid(),
    stage: changeStageSchema,
    endpoint: z.string(),
    patch: z.object({ allowedGroups: groupList }),
    baseBlobSha: z.string(),
    sourceCommitSha: z.string(),
    branch: z.string(),
    pr: z.object({ number: z.number().int(), url: z.string() }).nullable(),
    mergeCommitSha: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    diff: z.string().optional().openapi({ description: "Present on the response that created the request only." }),
  })
  .openapi("SsoChangeRecord");

export const ssoChangeListSchema = z.object({ items: z.array(ssoChangeRecordSchema) }).openapi("SsoChangeList");

export const ssoChangeContractSchema = z
  .object({
    editableEndpoints: z.array(z.string()).openapi({ example: ["flink", "filer"] }),
    field: z.literal("allowedGroups"),
    requiredGroups: z.array(z.string()).openapi({ example: ["admins"] }),
    availableGroups: groupList.openapi({ description: "Group names of policies/groups.yaml at sourceCommitSha." }),
    current: z
      .record(z.string(), groupList.nullable())
      .openapi({ description: "allowedGroups of each editable endpoint on main; null = field absent (no group check)." }),
    sourceCommitSha: z.string(),
    baseBlobSha: z.string(),
    gitWriterConfigured: z.boolean(),
  })
  .openapi("SsoChangeContract");

export const ssoChangeCancelBodySchema = z
  .object({ reason: z.string().max(MAX_REASON_LENGTH).optional().openapi({ example: "Wrong group selected" }) })
  .strict()
  .openapi("SsoChangeCancelBody");

export type SsoChangePreview = z.infer<typeof ssoChangePreviewSchema>;
export type SsoChangeRecordView = z.infer<typeof ssoChangeRecordSchema>;
