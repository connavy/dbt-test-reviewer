-- name: assert_no_orphan_orders
-- description: All orders must have a valid customer

WITH orders AS (
    SELECT * FROM {{ ref('fct_orders') }}
),
customers AS (
    SELECT * FROM {{ ref('dim_customers') }}
)

SELECT o.order_id
FROM orders o
LEFT JOIN customers c ON o.customer_id = c.customer_id
WHERE c.customer_id IS NULL
