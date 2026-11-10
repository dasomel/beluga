{{ config(enabled=target.name == 'ci') }}

with expected as (
  select cast('2026-11-09' as date) as order_date, 3 as order_count,
    2 as completed_order_count, cast(20.00 as decimal(18,2)) as completed_revenue
  union all
  select cast('2026-11-10' as date), 3, 1, cast(5.00 as decimal(18,2))
), actual as (
  select order_date, order_count, completed_order_count, completed_revenue
  from {{ ref('daily_revenue') }}
), missing as (
  select * from expected except select * from actual
), unexpected as (
  select * from actual except select * from expected
)
select * from missing
union all
select * from unexpected
