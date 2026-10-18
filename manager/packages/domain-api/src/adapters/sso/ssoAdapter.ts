import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

/**
 * D-MSSO-9/12: everything a preview or submit needs, read at ONE commit so the two files cannot disagree
 * (invariant: groups.yaml is read at the same commitSha as sso.yaml). `text` is the raw file (edited preserving
 * comments); `config` is the resolved, validated view of it.
 */
export interface SsoBase {
  commitSha: string;
  blobSha: string;
  text: string;
  baseDomain: string;
  config: SsoConfig;
  /** Names declared in policies/groups.yaml at the same commit. */
  groupNames: string[];
}

export interface ReadBaseOptions {
  /** Submit path: resolve current main now (no TTL cache) and refuse a stale/degraded answer. */
  fresh?: boolean;
}

export interface SsoAdapter {
  // The file adapter answers synchronously, the GitHub adapter (D-MSSO-12) over the network; callers always await.
  getSsoConfig(): SsoResponse | Promise<SsoResponse>;
  /** Write routes only. Absent = the source cannot back a change request (route answers 503). */
  readBase?(options?: ReadBaseOptions): Promise<SsoBase>;
}

// policies/groups.yaml: `groups: [{name, roles}]`. Contractual distrust: anything else is a source defect.
export function parseGroupNames(text: string, where: string): string[] {
  let raw: unknown;
  try {
    raw = yaml.parse(text);
  } catch (err) {
    throw new SsoConfigError(`Malformed YAML in ${where}`, err);
  }
  const groups = (raw as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) throw new SsoConfigError(`${where} must contain a groups list`);
  const names = groups.map((g) => (g as { name?: unknown } | null)?.name);
  if (!names.every((n): n is string => typeof n === "string" && n !== "")) {
    throw new SsoConfigError(`${where} has a group without a name`);
  }
  return names;
}

// The git blob object id of a file: sha1("blob <bytes>\0" + content). It is what GitHub reports as the file's sha,
// so the file adapter produces the same kind of value for local development.
export function gitBlobSha(text: string): string {
  const body = Buffer.from(text, "utf8");
  return crypto.createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

export class FileSsoAdapter implements SsoAdapter {
  private cachedMtimeMs: number | null = null;
  private cachedResult: SsoResponse | null = null;

  constructor(private readonly config: SsoAdapterConfig) {}

  // Local development / tests (D-MSSO-1): there is no git here, so the commit is a fixed marker and the blob
  // SHA is computed from the file content. groups.yaml is taken from <repo>/policies next to gitops/values.
  async readBase(): Promise<SsoBase> {
    const { filePath } = this.config;
    if (!filePath || !fs.existsSync(filePath)) throw new SsoConfigError("SSO configuration file is not available");
    const baseDomain = this.config.baseDomain ?? DEFAULT_BASE_DOMAIN;
    const groupsPath = this.config.groupsFilePath ?? path.resolve(path.dirname(filePath), "../../policies/groups.yaml");
    let text: string;
    let groupsText: string;
    try {
      text = fs.readFileSync(filePath, "utf-8");
      groupsText = fs.readFileSync(groupsPath, "utf-8");
    } catch (err) {
      throw new SsoConfigError("Failed to read SSO source files", err);
    }
    let raw: unknown;
    try {
      raw = yaml.parse(text);
    } catch (err) {
      throw new SsoConfigError(`Malformed YAML in SSO configuration file: ${filePath}`, err);
    }
    const resolved = resolveSsoFile(raw, baseDomain);
    if (!resolved.ok) throw new SsoConfigError(`Invalid SSO configuration in ${filePath}: ${resolved.summary}`);
    return {
      commitSha: "local-file",
      blobSha: gitBlobSha(text),
      text,
      baseDomain,
      config: resolved.config,
      groupNames: parseGroupNames(groupsText, groupsPath),
    };
  }

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
