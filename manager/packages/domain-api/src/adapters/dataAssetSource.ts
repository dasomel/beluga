// Source behind the Data Asset hierarchy routes (issue #36, ADR-0004). The fixture-backed source keeps
// today's behavior; the Lakekeeper source (upstream/lakekeeperCatalog.ts) is opt-in. Sources throw
// UpstreamError on upstream failure; routes translate that, never leak it.
import type { DataAsset, DataAssetDetail } from "../schema/dataAsset.js";
import { toDataAsset } from "../schema/dataAsset.js";
import type { ListWarning } from "../schema/envelope.js";

export interface DataAssetListResult {
  assets: DataAsset[]; // complete, un-paginated; the route filters by status/kind and paginates
  warnings: ListWarning[]; // source-level warnings (e.g. unfiltered authorization)
}

export interface DataAssetSource {
  // true: the route adds a per-item health warning for non-healthy assets (fixture behavior).
  readonly emitsItemHealthWarnings: boolean;
  // parentId undefined: fixture = flat all-assets list (ADR-0004 D6 compat); live = top-level catalogs only.
  list(filter: { parentId?: string }): Promise<DataAssetListResult>;
  get(id: string): Promise<DataAssetDetail | undefined>;
}

export function createFixtureDataAssetSource(details: readonly DataAssetDetail[]): DataAssetSource {
  return {
    emitsItemHealthWarnings: true,
    list: async ({ parentId }) => ({
      assets: details.map(toDataAsset).filter((asset) => parentId === undefined || asset.parentId === parentId),
      warnings: [],
    }),
    get: async (id) => details.find((asset) => asset.id === id),
  };
}

export function toDataAssetSource(source: readonly DataAssetDetail[] | DataAssetSource): DataAssetSource {
  return Array.isArray(source) ? createFixtureDataAssetSource(source) : (source as DataAssetSource);
}
