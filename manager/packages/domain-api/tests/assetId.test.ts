import { expect, test } from "vitest";
import { decodeIdSegment, deriveAssetId, encodeIdSegment } from "../src/lib/assetId.js";

test("deriveAssetId는 ADR-0004 D4 예시와 일치한다", () => {
  expect(deriveAssetId("catalog", ["iceberg"])).toBe("asset-catalog-iceberg");
  expect(deriveAssetId("schema", ["iceberg", "analytics"])).toBe("asset-schema-iceberg.analytics");
  expect(deriveAssetId("table", ["iceberg", "analytics", "orders"])).toBe("asset-table-iceberg.analytics.orders");
  expect(deriveAssetId("topic", ["kafka", "events-raw"])).toBe("asset-topic-kafka.events-raw");
  expect(deriveAssetId("catalog", ["ice.berg"])).toBe("asset-catalog-ice%2Eberg");
  expect(deriveAssetId("table", ["iceberg", "analytics", "orders.v2"])).toBe("asset-table-iceberg.analytics.orders%2Ev2");
});

test("중첩 namespace [a,b]와 리터럴 'a.b' segment는 서로 다른 id가 된다", () => {
  const nested = deriveAssetId("schema", ["iceberg", "a", "b"]);
  const literal = deriveAssetId("schema", ["iceberg", "a.b"]);
  expect(nested).toBe("asset-schema-iceberg.a.b");
  expect(literal).toBe("asset-schema-iceberg.a%2Eb");
  expect(nested).not.toBe(literal);
});

test("'.'와 '%'를 포함한 이름도 encode 후 decode하면 원본이 복원된다", () => {
  for (const name of ["a.b", "50%", "%2E", "x%252E.y", "plain", "..."]) {
    const encoded = encodeIdSegment(name);
    expect(encoded).not.toContain(".");
    expect(decodeIdSegment(encoded)).toBe(name);
  }
});
