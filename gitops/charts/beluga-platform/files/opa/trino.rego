package trino

import rego.v1

# =============================================================================
# §10 권한 매트릭스 (Authorization Matrix) - Trino Authz Policy
# =============================================================================
# 주체(Identity)        | Trino (쿼리 Engine)
# ---------------------+-------------------------------------------------------
# admin                | 전체 허용 (§10 admin 전체)
# engineer             | lake 읽기/쓰기 허용 (system 카탈로그 쓰기/변경 거부)
# analyst              | 읽기 전용 (customers PII 테이블 거부, 쓰기 계열 전부 거부)
# no-group (익명/서비스) | 기본 allow, customers PII 테이블 거부 (§10 OIDC 미연동 보호)
# =============================================================================

default allow = true

allow = false if {
    deny
}

# -----------------------------------------------------------------------------
# Deny Rules (§10 매트릭스 집행)
# -----------------------------------------------------------------------------

# [§10 analyst PII 차단] analyst 그룹의 customers 테이블 접근 거부
deny if {
    is_analyst
    is_customers_table
}

# [§10 analyst 읽기 전용] analyst 그룹의 쓰기/변경성 작업 거부
deny if {
    is_analyst
    is_write_operation
}

# [§10 engineer 시스템 카탈로그 변경 거부] engineer 그룹의 system 카탈로그 쓰기/변경 작업 거부
deny if {
    is_engineer
    is_system_catalog
    is_write_operation
}

# [§10 OIDC 미연동/익명 경로 보호] 그룹 없는 요청의 customers PII 테이블 접근 거부
deny if {
    not has_known_group
    is_customers_table
}

# -----------------------------------------------------------------------------
# Identity Helpers
# -----------------------------------------------------------------------------

is_admin if {
    input.context.identity.groups[_] == "admin"
}
is_admin if {
    input.context.identity.user == "admin"
}

is_engineer if {
    input.context.identity.groups[_] == "engineer"
}
is_engineer if {
    input.context.identity.user == "engineer"
}

is_analyst if {
    input.context.identity.groups[_] == "analyst"
}
is_analyst if {
    input.context.identity.user == "analyst"
}

has_known_group if {
    is_admin
}
has_known_group if {
    is_engineer
}
has_known_group if {
    is_analyst
}

# -----------------------------------------------------------------------------
# Resource & Operation Helpers
# -----------------------------------------------------------------------------

is_customers_table if {
    input.action.resource.table.tableName == "customers"
}
is_customers_table if {
    input.action.resource.column.tableName == "customers"
}

is_system_catalog if {
    input.action.resource.table.catalogName == "system"
}
is_system_catalog if {
    input.action.resource.catalog.name == "system"
}
is_system_catalog if {
    input.action.resource.schema.catalogName == "system"
}
is_system_catalog if {
    input.action.resource.column.catalogName == "system"
}

write_operations := [
    "InsertIntoTable",
    "CreateTable",
    "DropTable",
    "RenameTable",
    "AlterTable",
    "CreateSchema",
    "DropSchema",
    "RenameSchema",
    "CreateView",
    "DropView",
    "RenameView",
    "DeleteFromTable",
    "TruncateTable",
    "AddColumn",
    "DropColumn",
    "RenameColumn",
    "SetTableProperties",
    "ExecuteProcedure"
]

is_write_operation if {
    input.action.operation == write_operations[_]
}
