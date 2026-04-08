WITH stg_orders AS (
    SELECT * FROM {{ ref('stg_orders') }}
),

calc_totals AS (
    SELECT
        order_id,
        customer_id,
        order_date,
        status,
        qty * unit_price AS subtotal,
        COALESCE(discount, 0) AS discount_rate,
        CASE
            WHEN status = 'returned' THEN 0
            WHEN status = 'pending' THEN qty * unit_price
            ELSE qty * unit_price * (1 - COALESCE(discount, 0))
        END AS total
    FROM stg_orders
)

SELECT
    order_id,
    customer_id,
    order_date,
    status,
    total,
    discount_rate AS discount
FROM calc_totals
