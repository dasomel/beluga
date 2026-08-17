# 자동 생성 — 직접 수정하지 말 것. 원천: policies/*.yaml
package trino

import rego.v1

default allow := false

# 요청자의 그룹 (Trino OPA 입력의 실제 경로 — 라이브 실측: identity 키는 groups/user 뿐)
groups := object.get(input, ["context", "identity", "groups"], [])

# lake.customers — select (beluga-analyst, beluga-engineer)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "customers"
	some g in groups
	g in {"beluga-analyst", "beluga-engineer"}
}

# lake.customers — 행 필터
rowFilters contains {"expression": "region = 'KR'"} if {
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "customers"
	some g in groups
	g in {"beluga-analyst"}
}

# lake.customers.email — 마스킹(hash)
columnMask := {"expression": "to_hex(sha256(cast(email as varbinary)))"} if {
	input.action.resource.column.schemaName == "lake"
	input.action.resource.column.tableName == "customers"
	input.action.resource.column.columnName == "email"
	some g in groups
	g in {"beluga-analyst"}
}

# lake.customers — insert (beluga-engineer)
allow if {
	input.action.operation == "InsertIntoTable"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "customers"
	some g in groups
	g in {"beluga-engineer"}
}

# lake.customers — select (beluga-engineer)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "customers"
	some g in groups
	g in {"beluga-engineer"}
}

# lake.events_enriched — select (beluga-analyst, beluga-engineer)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "events_enriched"
	some g in groups
	g in {"beluga-analyst", "beluga-engineer"}
}
