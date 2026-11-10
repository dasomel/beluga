select order_id, total_amount
from {{ ref('orders') }}
where total_amount < 0
