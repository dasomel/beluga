import fs from "node:fs";
import yaml from "yaml";
import {
  ConfigError,
  DEFAULT_BASE_DOMAIN,
  loadSsoAdapterConfig,
  resolveBaseDomain,
  type SsoAdapterConfig,
} from "../../config.js";
import { resolveSsoFile, type SsoConfig, type SsoResponse } from "../../schema/sso.js";
import { GithubSsoAdapter } from "./githubSsoAdapter.js";

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
  // The file adapter answers synchronously, the GitHub adapter (D-MSSO-12) over the network; callers always await.
  getSsoConfig(): SsoResponse | Promise<SsoResponse>;
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

    // D-MSSO-1 & L1: Require top-level 'sso:' wrapper per rawSsoFileSchema; D-DOM-3: host labels -> FQDN.
    const resolved = resolveSsoFile(rawParsed, this.config.baseDomain ?? DEFAULT_BASE_DOMAIN);
    if (!resolved.ok) {
      throw new SsoConfigError(`Invalid SSO configuration in ${filePath}: ${resolved.summary}`);
    }

    const validatedConfig: SsoConfig = resolved.config;
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

export function createFileSsoAdapter(config: SsoAdapterConfig): FileSsoAdapter {
  return new FileSsoAdapter(config);
}

// D-MSSO-12: SSO_SOURCE=github|file. "file" is the local-development source (D-MSSO-1). In production there is no
// default: an unconfigured cluster deployment must not fall back to the file adapter silently.
export function createSsoAdapterFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): SsoAdapter {
  const raw = env["SSO_SOURCE"]?.trim();
  const isProduction = env["NODE_ENV"] === "production";
  const source = raw === undefined || raw === "" ? (isProduction ? undefined : "file") : raw;
  if (source === undefined) {
    throw new ConfigError("SSO_SOURCE must be set to 'github' or 'file' when NODE_ENV=production");
  }
  if (source === "github") {
    return new GithubSsoAdapter({ baseDomain: resolveBaseDomain(env), ...(fetchImpl ? { fetchImpl } : {}) });
  }
  // The file source is the development source (D-MSSO-1): BASE_DOMAIN when given, else the Vagrant default.
  if (source === "file") {
    return createFileSsoAdapter({ ...loadSsoAdapterConfig(env), baseDomain: env["BASE_DOMAIN"]?.trim() || DEFAULT_BASE_DOMAIN });
  }
  throw new ConfigError("SSO_SOURCE must be 'github' or 'file'");
}
