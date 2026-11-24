-- D-SHOP-4: service grants stay separate from compiled human policies.
-- Cost: explicit table/sequence list; escape hatch: extend only for reviewed demo scope.
-- CNPG owns LOGIN/password; the owner-run hook maintains demo metadata and grants.
\set ON_ERROR_STOP on
-- D-SHOP-11: durable row ownership preserves seed rows and normal status values.
-- Cost: one retained metadata column; escape hatch: disable and retain existing data.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS generator_owned BOOLEAN NOT NULL DEFAULT false;
GRANT CONNECT ON DATABASE shop TO shop_generator;
GRANT USAGE ON SCHEMA public TO shop_generator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders, public.customers TO shop_generator;
GRANT USAGE ON SEQUENCE public.orders_order_id_seq, public.customers_customer_id_seq TO shop_generator;
