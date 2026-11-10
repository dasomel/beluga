{% macro generate_schema_name(custom_schema_name, node) -%}
  {# D-DBT-1: preserve namespace boundaries; no target prefix. Cost: shared names.
     Use isolated catalogs/environments if concurrent deployments need separation. #}
  {{ custom_schema_name | trim if custom_schema_name else target.schema }}
{%- endmacro %}
