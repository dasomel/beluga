// Types for the dependency-free dev server in mock-upstreams.mjs (used by packages/domain-api tests).
export const DUMMY_TOKEN: "dev-dummy-token";

export interface MockUpstreamsOptions {
  host?: string;
  token?: string;
  /** Ports default to 0 (ephemeral). */
  flinkPort?: number;
  trinoPort?: number;
  lakekeeperPort?: number;
  flinkFixturesDir?: string;
}

export interface MockUpstreams {
  host: string;
  ports: { flink: number; trino: number; lakekeeper: number };
  close(): Promise<void>;
}

export function startMockUpstreams(options?: MockUpstreamsOptions): Promise<MockUpstreams>;
