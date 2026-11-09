CREATE TABLE source_orders (id INT, customer_id INT, amount DECIMAL(10, 2));
CREATE TABLE customers (id INT, name STRING);
CREATE TABLE silver (order_id INT, amount DECIMAL(10, 2));
INSERT INTO silver SELECT id, CAST(amount AS DECIMAL(10, 2)) FROM source_orders;
CREATE OR REPLACE VIEW gold AS
SELECT o.id AS order_id, upper(c.name) customer_name,
  o.amount * 2 AS doubled, coalesce(o.amount, 0) AS net,
  'ignore; FROM not_a_table' AS label
FROM source_orders o LEFT JOIN customers c ON o.customer_id = c.id;
CREATE VIEW totals AS SELECT customer_id, SUM(amount) AS total FROM source_orders GROUP BY customer_id;
INSERT INTO silver (amount, order_id) SELECT amount, id FROM source_orders;
