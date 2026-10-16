import fs from "node:fs";
import yaml from "yaml";
import { loadSsoAdapterConfig, type SsoAdapterConfig } from "../../config.js";
import {
  rawSsoFileSchema,
  type SsoConfig,
  type SsoResponse,
} from "../../schema/sso.js";

// D-MSSO-1: Source/file path choice: Reads GitOps declarative SSO configuration from gitops/values/sso.yaml.
// In dev/test, automatically resolves from repository root. In production without SSO_CONFIG_FILE,
// fails closed to a typed "not-configured" state.
// D-MSSO-2: Read-only boundary: Domain model represents declared Git state. Write operations deferred to Stage 3.
// D-MSSO-3: Strict schema validation & contractual distrust: Rejects non-HTTPS issuer, invalid DNS names,
// malformed paths, and unknown modes. Malformed YAML or schema invalidity throws SsoConfigError (mapped to 503).
// D-MSSO-4: In-memory file cache with mtime validation to avoid redundant disk I/O while tracking live file edits.

export class SsoConfigError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SsoConfigError";
  }
}

export interface SsoAdapter {
  getSsoConfig(): SsoResponse;
}

export class FileSsoAdapter implements SsoAdapter {
  private cachedMtimeMs: number | null = null;
  private cachedResult: SsoResponse | null = null;

  constructor(private readonly config: SsoAdapterConfig) {}

  getSsoConfig(): SsoResponse {
    const { filePath, isProduction } = this.config;

    if (!filePath) {
      return {
        status: "not-configured",
        configured: false,
        message: isProduction
          ? "SSO configuration file is not configured (SSO_CONFIG_FILE unset in production)"
          : "SSO configuration file not configured",
      };
    }

    if (!fs.existsSync(filePath)) {
      return {
        status: "not-configured",
        configured: false,
        message: `SSO configuration file not found: ${filePath}`,
      };
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      throw new SsoConfigError(`Failed to stat SSO configuration file: ${filePath}`, err);
    }

    // Return cached parsed result if mtime has not changed
    if (this.cachedMtimeMs !== null && this.cachedMtimeMs === stat.mtimeMs && this.cachedResult !== null) {
      return this.cachedResult;
    }

    let fileContent: string;
    try {
      fileContent = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new SsoConfigError(`Failed to read SSO configuration file: ${filePath}`, err);
    }

    let rawParsed: unknown;
    try {
      rawParsed = yaml.parse(fileContent);
    } catch (err) {
      throw new SsoConfigError(`Malformed YAML in SSO configuration file: ${filePath}`, err);
    }

    if (!rawParsed || typeof rawParsed !== "object") {
      throw new SsoConfigError(`SSO configuration file must contain a YAML object: ${filePath}`);
    }

    // D-MSSO-1 & L1: Require top-level 'sso:' wrapper per rawSsoFileSchema
    const parseResult = rawSsoFileSchema.safeParse(rawParsed);
    if (!parseResult.success) {
      const issueSummary = parseResult.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ");
      throw new SsoConfigError(`Invalid SSO configuration in ${filePath}: ${issueSummary}`);
    }

    const validatedConfig: SsoConfig = parseResult.data.sso;
    const response: SsoResponse = {
      status: "configured",
      configured: true,
      source: {
        kind: "git-file",
        path: filePath,
        loadedAt: new Date().toISOString(),
      },
      config: validatedConfig,
    };

    this.cachedMtimeMs = stat.mtimeMs;
    this.cachedResult = response;
    return response;
  }
}

export function createFileSsoAdapter(config: SsoAdapterConfig): SsoAdapter {
  return new FileSsoAdapter(config);
}

export function createSsoAdapterFromEnv(env: Record<string, string | undefined>): SsoAdapter {
  const config = loadSsoAdapterConfig(env);
  return createFileSsoAdapter(config);
}
