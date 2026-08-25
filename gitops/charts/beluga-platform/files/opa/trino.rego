# 자동 생성 — 직접 수정하지 말 것. 원천: policies/*.yaml
package trino

import rego.v1

default allow := false

# 요청자의 그룹 (Trino OPA 입력의 실제 경로 — 라이브 실측: identity 키는 groups/user 뿐)
groups := object.get(input, ["context", "identity", "groups"], [])

# lake.customers — delete (admins, engineers)
allow if {
	input.action.operation == "DeleteFromTable"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "customers"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.customers — insert (admins, engineers)
allow if {
	input.action.operation == "InsertIntoTable"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "customers"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.customers — select (admins, engineers)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "customers"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.customers — update (admins, engineers)
allow if {
	input.action.operation == "UpdateTableColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "customers"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.events_enriched — select (admins, analysts, engineers)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "events_enriched"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# lake.events_enriched — delete (admins, engineers)
allow if {
	input.action.operation == "DeleteFromTable"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "events_enriched"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.events_enriched — insert (admins, engineers)
allow if {
	input.action.operation == "InsertIntoTable"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "events_enriched"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.events_enriched — select (admins, engineers)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "events_enriched"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.events_enriched — update (admins, engineers)
allow if {
	input.action.operation == "UpdateTableColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "events_enriched"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.orders — select (admins, analysts, engineers)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "orders"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# lake.orders — delete (admins, engineers)
allow if {
	input.action.operation == "DeleteFromTable"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "orders"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.orders — insert (admins, engineers)
allow if {
	input.action.operation == "InsertIntoTable"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "orders"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.orders — select (admins, engineers)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "orders"
	some g in groups
	g in {"admins", "engineers"}
}

# lake.orders — update (admins, engineers)
allow if {
	input.action.operation == "UpdateTableColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "lake"
	input.action.resource.table.tableName == "orders"
	some g in groups
	g in {"admins", "engineers"}
}

# 카탈로그 iceberg — AccessCatalog (admins, analysts, engineers)
allow if {
	input.action.operation == "AccessCatalog"
	input.action.resource.catalog.name == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — ExecuteQuery (admins, analysts, engineers)
allow if {
	input.action.operation == "ExecuteQuery"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — FilterCatalogs (admins, analysts, engineers)
allow if {
	input.action.operation == "FilterCatalogs"
	input.action.resource.catalog.name == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — FilterSchemas (admins, analysts, engineers)
allow if {
	input.action.operation == "FilterSchemas"
	input.action.resource.schema.catalogName == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — FilterTables (admins, analysts, engineers)
allow if {
	input.action.operation == "FilterTables"
	input.action.resource.table.catalogName == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — SetCatalogSessionProperty (admins, analysts, engineers)
allow if {
	input.action.operation == "SetCatalogSessionProperty"
	input.action.resource.catalogSessionProperty.catalogName == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — ShowColumns (admins, analysts, engineers)
allow if {
	input.action.operation == "ShowColumns"
	input.action.resource.table.catalogName == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — ShowCreateTable (admins, analysts, engineers)
allow if {
	input.action.operation == "ShowCreateTable"
	input.action.resource.table.catalogName == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — ShowFunctions (admins, analysts, engineers)
allow if {
	input.action.operation == "ShowFunctions"
	input.action.resource.schema.catalogName == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — ShowSchemas (admins, analysts, engineers)
allow if {
	input.action.operation == "ShowSchemas"
	input.action.resource.catalog.name == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — ShowTables (admins, analysts, engineers)
allow if {
	input.action.operation == "ShowTables"
	input.action.resource.schema.catalogName == "iceberg"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}

# 카탈로그 iceberg — information_schema SELECT (admins, analysts, engineers, SHOW TABLES/COLUMNS 등이 내부적으로 요구)
allow if {
	input.action.operation == "SelectFromColumns"
	input.action.resource.table.catalogName == "iceberg"
	input.action.resource.table.schemaName == "information_schema"
	some g in groups
	g in {"admins", "analysts", "engineers"}
}
