{% macro dbt_run_audit_nodes(results) -%}
  {% set nodes = [] %}
  {% if execute and flags.WHICH == 'build' %}
    {% for result in results if result.node.resource_type in ['model', 'test', 'seed'] %}
      {% do nodes.append(result) %}
    {% endfor %}
  {% endif %}
  {{ return(nodes) }}
{%- endmacro %}

{% macro dbt_run_audit_relation() -%}
  {{ return(api.Relation.create(database=target.database, schema='gold_shop',
                                identifier='dbt_run_audit')) }}
{%- endmacro %}

{% macro dbt_audit_literal(value) -%}
  {% if value is none %}null{% else %}'{{ (value | string).replace("'", "''") }}'{% endif %}
{%- endmacro %}

{# D-DBT-16: separate SQL hooks use Core's safe_run_hooks error handling, preserving
   original node failures even if audit SQL fails. Cost: three statements; escape
   hatch: retain run_results.json for diagnosis/recovery when storage is unavailable.
   Empty results are no-ops; a failed build still records skipped downstream nodes. #}
{% macro dbt_run_audit_schema(results) -%}
  {% if dbt_run_audit_nodes(results) | length %}
    create schema if not exists {{ dbt_run_audit_relation().without_identifier() }}
  {% endif %}
{%- endmacro %}

{% macro dbt_run_audit_table(results) -%}
  {% if dbt_run_audit_nodes(results) | length %}
    create table if not exists {{ dbt_run_audit_relation() }} (
      invocation_id {{ dbt.type_string() }},
      run_started_at timestamp(6),
      dbt_version {{ dbt.type_string() }},
      target_name {{ dbt.type_string() }},
      target_engine {{ dbt.type_string() }},
      project_git_revision {{ dbt.type_string() }},
      orchestrator_run_id {{ dbt.type_string() }},
      node_unique_id {{ dbt.type_string() }},
      resource_type {{ dbt.type_string() }},
      materialization {{ dbt.type_string() }},
      "relation" {{ dbt.type_string() }},
      status {{ dbt.type_string() }},
      execution_time {{ dbt.type_float() }},
      rows_affected {{ dbt.type_bigint() }},
      failures {{ dbt.type_bigint() }},
      message {{ dbt.type_string() }}
    )
  {% endif %}
{%- endmacro %}

{% macro dbt_run_audit_insert(results) -%}
  {% set nodes = dbt_run_audit_nodes(results) %}
  {% if nodes | length %}
    insert into {{ dbt_run_audit_relation() }} (
      invocation_id, run_started_at, dbt_version, target_name, target_engine,
      project_git_revision, orchestrator_run_id, node_unique_id, resource_type,
      materialization, "relation", status, execution_time, rows_affected, failures, message
    ) values
    {% for result in nodes %}
      {% set node = result.node %}
      {% set is_test = node.resource_type == 'test' %}
      {% set affected = result.adapter_response.get('rows_affected') %}
      {% set relation = none if is_test else [node.database, node.schema, node.alias] | join('.') %}
      {# D-DBT-16: allowlisted summaries avoid persisting SQL, credentials or data from
         arbitrary adapter errors. Cost: less detail; escape hatch: protected dbt logs.
         timestamp(6) is UTC without zone, supported by both DuckDB and Iceberg. #}
      {% set message = 'status=' ~ result.status ~ ('; failures=' ~ result.failures if is_test else '') %}
      (
        {{ dbt_audit_literal(invocation_id) }},
        cast({{ dbt_audit_literal(run_started_at.strftime('%Y-%m-%d %H:%M:%S.%f')) }} as timestamp(6)),
        {{ dbt_audit_literal(dbt_version) }},
        {{ dbt_audit_literal(target.name) }}, {{ dbt_audit_literal(target.type) }},
        {{ dbt_audit_literal(env_var('BELUGA_DBT_GIT_SHA', 'unknown')) }},
        {{ dbt_audit_literal(env_var('BELUGA_ORCHESTRATOR_RUN_ID', 'manual')) }},
        {{ dbt_audit_literal(node.unique_id) }}, {{ dbt_audit_literal(node.resource_type) }},
        {{ dbt_audit_literal(none if is_test else node.config.materialized) }},
        {{ dbt_audit_literal(relation) }}, {{ dbt_audit_literal(result.status) }},
        {{ result.execution_time | float }},
        {{ affected | int if affected is not none and affected | int >= 0 else 'null' }},
        {{ result.failures | int if is_test and result.failures is not none else 'null' }},
        {{ dbt_audit_literal(message[:512]) }}
      ){% if not loop.last %},{% endif %}
    {% endfor %}
  {% endif %}
{%- endmacro %}
