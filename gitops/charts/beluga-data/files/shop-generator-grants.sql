-- D-SHOP-4: service grants stay separate from compiled human policies.
-- Cost: explicit table/sequence list; escape hatch: extend only for reviewed demo scope.
-- CNPG owns LOGIN/password; this idempotent owner-run hook only grants shop DML.
\set ON_ERROR_STOP on
GRANT CONNECT ON DATABASE shop TO shop_generator;
GRANT USAGE ON SCHEMA public TO shop_generator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders, public.customers TO shop_generator;
GRANT USAGE ON SEQUENCE public.orders_order_id_seq, public.customers_customer_id_seq TO shop_generator;
