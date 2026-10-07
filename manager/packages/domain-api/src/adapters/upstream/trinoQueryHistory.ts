// Read-only Trino query-state adapter for GET /api/v1/query-history (issue #17).
//
// Upstream contract and its limits (Trino 483):
//   - GET /v1/query -> JSON array of BasicQueryInfo (queryId, state, query, ...). Source:
//     https://github.com/trinodb/trino/blob/483/core/trino-main/src/main/java/io/trino/server/QueryResource.java
//     and .../BasicQueryInfo.java. The endpoint is @ResourceSecurity(AUTHENTICATED_USER) and filters the
//     list with the access control for the *authenticated identity*.
//   - It is NOT part of the documented client protocol (https://trino.io/docs/483/develop/client-protocol.html
//     documents /v1/statement only) nor of the web-UI page (https://trino.io/docs/483/admin/web-interface.html);
//     it is the web UI's backing endpoint, so its shape may change between Trino versions.
//   - X-Trino-User is optional per the 483 client-protocol docs ("If not supplied, the session user is
//     automatically determined via User mapping"); with an authenticated bearer token the identity comes
//     from the token, so the header is only sent when explicitly configured.
//   - History is only what the coordinator still retains (query.max-history / min-expire-age); it is not
//     a persistent store, and the order is whatever the coordinator returns.
// The result reflects the visibility of Manager's service credential, not of the end user (see docs).
import { z } from "@hono/zod-openapi";
import type { QueryHistoryAdapter } from "../queryHistory.js";
import { queryHistoryEntrySchema, type QueryHistoryEntry } from "../../schema/queryHistory.js";
import { UpstreamError } from "./errors.js";
import type { UpstreamHttpClient } from "./httpClient.js";
import { redactSqlLiterals } from "./sqlRedaction.js";

// Only the fields we map; unknown BasicQueryInfo fields (session, queryStats, ...) are dropped on parse.
const basicQueryInfoSchema = z.object({
  queryId: z.string().min(1),
  state: z.string().min(1),
  query: z.string(),
});
const MAX_ENTRIES = 1000;

export interface TrinoQueryHistoryOptions {
  client: UpstreamHttpClient;
  // Default true: string/numeric literals and comments are removed from `sql` (see sqlRedaction.ts).
  redactSql?: boolean;
}

export function createTrinoQueryHistoryAdapter(options: TrinoQueryHistoryOptions): QueryHistoryAdapter {
  const redact = options.redactSql ?? true;
  return {
    async listQueryHistory(): Promise<readonly QueryHistoryEntry[]> {
      const body = await options.client.getJson("/v1/query");
      const parsed = z.array(basicQueryInfoSchema).safeParse(body);
      if (!parsed.success) throw new UpstreamError("malformed", "trino"); // fail closed, no partial list
      return parsed.data.slice(0, MAX_ENTRIES).map((item) =>
        queryHistoryEntrySchema.parse({
          id: item.queryId,
          sql: (redact ? redactSqlLiterals(item.query) : item.query).trim() || "<empty>",
          state: item.state,
        }),
      );
    },
  };
}
