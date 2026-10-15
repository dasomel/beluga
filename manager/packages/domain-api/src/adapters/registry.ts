import type { Service } from "../schema/service.js";
import { SUPPORTED_ADAPTER_CONTRACT_VERSIONS, type ServiceAdapter } from "./types.js";

export const DEFAULT_ADAPTER_TIMEOUT_MS = 3000;

export class UnsupportedAdapterVersionError extends Error {
  constructor(adapterId: string, contractVersion: number) {
    super(
      `Adapter '${adapterId}' declares contract version ${contractVersion}; ` +
        `supported versions: ${SUPPORTED_ADAPTER_CONTRACT_VERSIONS.join(", ")}`,
    );
    this.name = "UnsupportedAdapterVersionError";
  }
}

export class DuplicateAdapterError extends Error {
  constructor(adapterId: string) {
    super(`Adapter '${adapterId}' is already registered`);
    this.name = "DuplicateAdapterError";
  }
}

export class AdapterTimeoutError extends Error {
  constructor(adapterId: string, timeoutMs: number) {
    super(`Adapter '${adapterId}' did not respond within ${timeoutMs}ms`);
    this.name = "AdapterTimeoutError";
  }
}

// 등록 시점에 identity를 고정해 둔다 — 이후 어댑터 객체가 바뀌거나 getter가 던져도
// 폴백 경로가 안전하고, health/metadata가 identity를 덮어쓸 수 없다.
interface Entry {
  adapter: ServiceAdapter;
  id: string;
  name: string;
  type: Service["type"];
}

// 폴백은 "방금 확인했다"고 주장하지 않는다: epoch + staleAfterMs 0.
const NEVER_CHECKED_AT = new Date(0).toISOString();

export class ServiceAdapterRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    adapters: readonly ServiceAdapter[] = [],
    private readonly timeoutMs: number = DEFAULT_ADAPTER_TIMEOUT_MS,
  ) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: ServiceAdapter): void {
    if (!SUPPORTED_ADAPTER_CONTRACT_VERSIONS.includes(adapter.contractVersion)) {
      throw new UnsupportedAdapterVersionError(adapter.id, adapter.contractVersion);
    }
    if (this.entries.has(adapter.id)) {
      throw new DuplicateAdapterError(adapter.id);
    }
    this.entries.set(adapter.id, { adapter, id: adapter.id, name: adapter.name, type: adapter.type });
  }

  // 등록 순서를 유지한다. 한 어댑터의 실패/지연은 해당 서비스만 unknown으로 낮추고 나머지에 영향이 없다.
  async listServices(type?: Service["type"]): Promise<Service[]> {
    // D1: 고정 identity로 먼저 선택해 불필요한 호출을 막는다. O(n) 선택 비용이며,
    // type 생략 시 전체 조회로 돌아간다. health 기반 status는 조회 후에만 필터링한다.
    const entries = [...this.entries.values()].filter((entry) => type === undefined || entry.type === type);
    return Promise.all(entries.map((entry) => this.resolve(entry)));
  }

  async getService(id: string): Promise<Service | undefined> {
    const entry = this.entries.get(id);
    return entry ? this.resolve(entry) : undefined;
  }

  private async resolve(entry: Entry): Promise<Service> {
    const { adapter, id, name, type } = entry;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AdapterTimeoutError(id, this.timeoutMs)), this.timeoutMs);
      });
      const fetched = (async () =>
        Promise.all([adapter.getMetadata(), adapter.getVersion(), adapter.getHealth()]))();
      fetched.catch(() => {}); // 타임아웃 이후의 늦은 reject가 unhandled가 되지 않게 한다.
      const [metadata, version, health] = await Promise.race([fetched, deadline]);
      // 필드를 명시적으로 고른다: 어댑터가 반환한 여분의 키는 응답에 새지 않고 identity도 덮어쓸 수 없다.
      return {
        id,
        name,
        type,
        version,
        status: health.status,
        endpoint: metadata.endpoint,
        capabilities: metadata.capabilities,
        capabilityCategories: metadata.capabilityCategories,
        namespace: metadata.namespace,
        workloadRef: metadata.workloadRef,
        keyMetrics: metadata.keyMetrics,
        dependencies: metadata.dependencies,
        lastCheckedAt: health.lastCheckedAt,
        staleAfterMs: health.staleAfterMs,
      };
    } catch (err) {
      // 내부 오류 세부사항은 응답에 싣지 않고 서버 로그로만 남긴다(app.onError와 동일 원칙).
      console.error(`Adapter '${id}' failed; degrading to unknown`, err);
      return {
        id,
        name,
        type,
        version: null,
        status: "unknown",
        endpoint: null,
        capabilities: [],
        capabilityCategories: [],
        namespace: null,
        workloadRef: null,
        keyMetrics: [],
        dependencies: [],
        lastCheckedAt: NEVER_CHECKED_AT,
        staleAfterMs: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
