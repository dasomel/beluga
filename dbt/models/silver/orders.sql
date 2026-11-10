{% if target.name == 'ci' %}
-- depends_on: {{ ref('orders_invalid' if var('gate_negative', false) else 'orders_fixture') }}
{% endif %}

with typed as (
  select
    cast(order_id as integer) as order_id,
    cast(customer_id as integer) as customer_id,
    cast(total_amount as decimal(10,2)) as total_amount,
    lower(trim(cast(status as {{ dbt.type_string() }}))) as status,
    cast(updated_at as timestamp(3)) as updated_at
  from {{ source('lake', 'orders') }}
), ranked as (
  select *, row_number() over (
    partition by order_id
    order by updated_at desc nulls last, customer_id desc nulls last,
      total_amount desc nulls last, status desc nulls last
  ) as row_rank
  from typed
)
select order_id, customer_id, total_amount, status, updated_at
from ranked
where row_rank = 1
