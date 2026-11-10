select
  cast(updated_at as date) as order_date,
  count(*) as order_count,
  sum(case when status = 'completed' then 1 else 0 end) as completed_order_count,
  cast(sum(case when status = 'completed' then total_amount else 0 end)
    as decimal(18,2)) as completed_revenue
from {{ ref('orders') }}
group by cast(updated_at as date)
