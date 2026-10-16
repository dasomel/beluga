import { z } from "@hono/zod-openapi";

// D-MSSO-3: Strict validation / contractual distrust (OpenForge & Beluga integration contract):
// Hostnames must strictly be valid DNS names, issuer must be HTTPS, paths must begin with "/",
// and modes must strictly be one of gateway-oidc | app-oidc | none.

/** Validates RFC 1123 DNS hostname syntax (labels separated by dot, alphanumeric + hyphens). */
export function isValidDnsName(val: string): boolean {
  if (typeof val !== "string" || val.length === 0 || val.length > 253) return false;
  const labelRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const labels = val.split(".");
  return labels.every((label) => labelRegex.test(label));
}

export const ssoEndpointModeSchema = z
  .enum(["gateway-oidc", "app-oidc", "none"])
  .openapi("SsoEndpointMode");

export const dnsHostSchema = z
  .string()
  .min(1, { message: "Host must not be empty" })
  .max(253, { message: "Host must not exceed 253 characters" })
  .refine(isValidDnsName, { message: "Host must be a valid DNS hostname" })
  .openapi({ example: "flink.local.beluga.internal" });

export const httpsUrlSchema = z
  .string()
  .url({ message: "Issuer must be a valid URL" })
  .refine(
    (val) => {
      try {
        const u = new URL(val);
        return u.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Issuer must use https protocol" },
  )
  .openapi({ example: "https://sso.local.beluga.internal/realms/beluga" });

export const pathPrefixSchema = z
  .string()
  .refine((p) => p.startsWith("/"), { message: 'Path prefix must start with "/"' })
  .openapi({ example: "/*" });

export const redirectPathSchema = z
  .string()
  .refine((p) => p === "" || p.startsWith("/"), { message: 'Redirect path must be empty or start with "/"' })
  .openapi({ example: "/.apisix/redirect" });

export const logoutPathSchema = z
  .string()
  .refine((p) => p === "" || p.startsWith("/"), { message: 'Logout path must be empty or start with "/"' })
  .optional()
  .openapi({ example: "/logout" });

// D-MSSO-2: Read-only model in Stage 2. Designed so that Stage 3 can serialize the same
// schema directly back into gitops/values/sso.yaml when creating Git pull requests.
export const ssoEndpointSchema = z
  .object({
    name: z.string().min(1).openapi({ example: "flink" }),
    host: dnsHostSchema,
    mode: ssoEndpointModeSchema,
    clientId: z.string().openapi({ example: "apisix-gateway" }),
    protectedPathPrefixes: z.array(pathPrefixSchema).openapi({ example: ["/*"] }),
    bypassPathPrefixes: z.array(pathPrefixSchema).openapi({ example: [] }),
    redirectPath: redirectPathSchema,
    logoutPath: logoutPathSchema,
  })
  .strict()
  .superRefine((endpoint, ctx) => {
    if (endpoint.mode === "gateway-oidc" || endpoint.mode === "app-oidc") {
      if (!endpoint.clientId || endpoint.clientId.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Endpoint "${endpoint.name}" with mode "${endpoint.mode}" must have a non-empty clientId`,
          path: ["clientId"],
        });
      }
    }

    if (endpoint.mode === "gateway-oidc") {
      if (!endpoint.protectedPathPrefixes || endpoint.protectedPathPrefixes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Gateway-OIDC endpoint "${endpoint.name}" must have non-empty protectedPathPrefixes`,
          path: ["protectedPathPrefixes"],
        });
      }
      if (!endpoint.redirectPath || endpoint.redirectPath.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Gateway-OIDC endpoint "${endpoint.name}" must have a non-empty redirectPath`,
          path: ["redirectPath"],
        });
      }
      if (!endpoint.logoutPath || endpoint.logoutPath.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Gateway-OIDC endpoint "${endpoint.name}" must have a non-empty logoutPath`,
          path: ["logoutPath"],
        });
      }
    }
  })
  .openapi("SsoEndpoint");

export const ssoConfigSchema = z
  .object({
    realm: z.string().min(1).openapi({ example: "beluga" }),
    issuerHost: dnsHostSchema,
    issuer: httpsUrlSchema,
    endpoints: z.array(ssoEndpointSchema),
  })
  .strict()
  .superRefine((config, ctx) => {
    try {
      const u = new URL(config.issuer);
      if (u.hostname !== config.issuerHost && u.host !== config.issuerHost) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Issuer host "${u.host}" does not match issuerHost "${config.issuerHost}"`,
          path: ["issuer"],
        });
      }
      const expectedPath = `/realms/${config.realm}`;
      if (u.pathname !== expectedPath && u.pathname.replace(/\/+$/, "") !== expectedPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Issuer path "${u.pathname}" does not match expected path "${expectedPath}"`,
          path: ["issuer"],
        });
      }
    } catch {
      // Ignored: URL validity already verified by httpsUrlSchema
    }

    const seenNames = new Set<string>();
    for (let i = 0; i < config.endpoints.length; i++) {
      const ep = config.endpoints[i];
      if (!ep) continue;
      if (seenNames.has(ep.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate endpoint name "${ep.name}"`,
          path: ["endpoints", i, "name"],
        });
      } else {
        seenNames.add(ep.name);
      }
    }
  })
  .openapi("SsoConfig");

export const rawSsoFileSchema = z
  .object({
    sso: ssoConfigSchema,
  })
  .strict();

export const ssoSourceSchema = z
  .object({
    kind: z.literal("git-file").openapi({ example: "git-file" }),
    path: z.string().openapi({ example: "gitops/values/sso.yaml" }),
    loadedAt: z.string().openapi({ example: "2026-10-17T00:00:00.000Z" }),
  })
  .openapi("SsoSource");

export const ssoConfiguredResponseSchema = z
  .object({
    status: z.literal("configured"),
    configured: z.literal(true),
    source: ssoSourceSchema,
    config: ssoConfigSchema,
  })
  .openapi("SsoConfiguredResponse");

export const ssoNotConfiguredResponseSchema = z
  .object({
    status: z.literal("not-configured"),
    configured: z.literal(false),
    message: z.string().openapi({ example: "SSO configuration file is not configured" }),
  })
  .openapi("SsoNotConfiguredResponse");

export const ssoResponseSchema = z
  .discriminatedUnion("status", [ssoConfiguredResponseSchema, ssoNotConfiguredResponseSchema])
  .openapi("SsoResponse");

export type SsoEndpointMode = z.infer<typeof ssoEndpointModeSchema>;
export type SsoEndpoint = z.infer<typeof ssoEndpointSchema>;
export type SsoConfig = z.infer<typeof ssoConfigSchema>;
export type RawSsoFile = z.infer<typeof rawSsoFileSchema>;
export type SsoSource = z.infer<typeof ssoSourceSchema>;
export type SsoConfiguredResponse = z.infer<typeof ssoConfiguredResponseSchema>;
export type SsoNotConfiguredResponse = z.infer<typeof ssoNotConfiguredResponseSchema>;
export type SsoResponse = z.infer<typeof ssoResponseSchema>;
