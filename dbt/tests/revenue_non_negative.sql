select order_date, completed_revenue
from {{ ref('daily_revenue') }}
where completed_revenue < 0
