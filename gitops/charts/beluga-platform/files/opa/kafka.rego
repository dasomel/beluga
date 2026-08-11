package kafka.authz

import rego.v1

# =============================================================================
# §10 권한 매트릭스 (Authorization Matrix) - Kafka Authz Policy
# =============================================================================
# 주체(Identity)        | Kafka (스트리밍 Platform)
# ---------------------+-------------------------------------------------------
# admin                | 전체 허용 (§10 admin 전체)
# engineer             | 토픽 읽기/쓰기 허용 (§10 engineer Read/Write)
# analyst              | 토픽 읽기만 허용 (§10 analyst Read만, Write/Delete/Alter 거부)
# =============================================================================

default allow = true

allow = false if {
    deny
}

# -----------------------------------------------------------------------------
# Deny Rules (§10 매트릭스 집행)
# -----------------------------------------------------------------------------

# [§10 analyst Write/Delete/Alter 거부] analyst 그룹/프린시펄의 토픽 쓰기 및 변경 작업 거부
deny if {
    is_analyst
    is_restricted_kafka_operation
}

# -----------------------------------------------------------------------------
# Identity Helpers (principal.name 규칙 및 groups 클레임 둘 다 지원)
# -----------------------------------------------------------------------------

is_admin if {
    input.requestContext.principal.name == "User:admin"
}
is_admin if {
    input.requestContext.principal.name == "User:beluga-admin"
}
is_admin if {
    input.requestContext.principal.name == "admin"
}
is_admin if {
    input.requestContext.principal.groups[_] == "admin"
}
is_admin if {
    input.requestContext.groups[_] == "admin"
}

is_engineer if {
    input.requestContext.principal.name == "User:engineer"
}
is_engineer if {
    input.requestContext.principal.name == "User:beluga-engineer"
}
is_engineer if {
    input.requestContext.principal.name == "engineer"
}
is_engineer if {
    input.requestContext.principal.groups[_] == "engineer"
}
is_engineer if {
    input.requestContext.groups[_] == "engineer"
}

is_analyst if {
    input.requestContext.principal.name == "User:analyst"
}
is_analyst if {
    input.requestContext.principal.name == "User:beluga-analyst"
}
is_analyst if {
    input.requestContext.principal.name == "analyst"
}
is_analyst if {
    input.requestContext.principal.groups[_] == "analyst"
}
is_analyst if {
    input.requestContext.groups[_] == "analyst"
}

# -----------------------------------------------------------------------------
# Operation Helpers
# -----------------------------------------------------------------------------

restricted_kafka_operations := [
    "Write",
    "Delete",
    "Alter",
    "AlterConfigs",
    "ClusterAction",
    "Create"
]

is_restricted_kafka_operation if {
    input.action.operation == restricted_kafka_operations[_]
}
