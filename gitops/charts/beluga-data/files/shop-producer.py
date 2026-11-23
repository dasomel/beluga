#!/usr/bin/env python3
"""Bounded synthetic shop writes; no DDL or privileged credentials."""

import math
import os
import random
import time
import uuid
from decimal import Decimal


# D-SHOP-1: one committed mutation per tick, with deterministic c/u/d mix.
# Cost: catch-up deletes take multiple ticks; escape hatch: lower caps/rate in values.
def operation(tick, orders, customers, max_orders, max_customers):
    if orders >= max_orders:
        return "delete_order"
    if customers == 0:
        return "insert_customer"
    slot = tick % 10
    if slot == 8 and customers < max_customers:
        return "insert_customer"
    if slot == 9 or slot == 8:
        return "update_customer"
    if slot == 5 and orders:
        return "delete_order"
    if slot in (1, 2, 4, 7) and orders:
        return "update_order"
    return "insert_order"


SQL = {
    "insert_customer": "INSERT INTO public.customers (name, email, city) VALUES (%s, %s, %s)",
    "update_customer": "UPDATE public.customers SET name = %s, city = %s WHERE customer_id = %s",
    "insert_order": "INSERT INTO public.orders (customer_id, total_amount, status) VALUES (%s, %s, %s)",
    "update_order": "UPDATE public.orders SET status = %s, total_amount = %s, updated_at = CURRENT_TIMESTAMP WHERE order_id = %s",
    "delete_order": "DELETE FROM public.orders WHERE order_id = %s",
}


def statement(action, order_id, customer_id, tick, email_domain):
    amount = Decimal(random.randint(100, 50000)) / 100
    status = ("PENDING", "SHIPPED", "COMPLETED", "CANCELLED")[tick % 4]
    city = ("Seoul", "Busan", "Incheon")[tick % 3]
    params = {
        "insert_customer": ("Demo shopper", uuid.uuid4().hex + "@" + email_domain, city),
        "update_customer": ("Demo shopper " + str(tick % 100), city, customer_id),
        "insert_order": (customer_id, amount, status),
        "update_order": (status, amount, order_id),
        "delete_order": (order_id,),
    }
    return SQL[action], params[action]


def config():
    interval = float(os.getenv("WRITE_INTERVAL_SECONDS", "3"))
    orders = int(os.getenv("MAX_ORDERS", "1000"))
    customers = int(os.getenv("MAX_CUSTOMERS", "100"))
    log_every = int(os.getenv("LOG_EVERY", "20"))
    if not math.isfinite(interval) or interval < 1 or min(orders, customers, log_every) < 1:
        raise ValueError("interval must be finite and >=1; caps/log frequency must be positive")
    email_domain = os.getenv("EMAIL_DOMAIN", "")
    if not email_domain or len(email_domain) > 67 or "@" in email_domain:
        raise ValueError("EMAIL_DOMAIN must fit the customer email column")
    return interval, orders, customers, log_every, email_domain


def write_once(conn, tick, max_orders, max_customers, email_domain):
    with conn:
        with conn.cursor() as cur:
            # D-SHOP-2: transaction lock serializes overlapping replicas/restarts.
            # Cost: one waiting writer; escape hatch: keep Recreate + one replica.
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (739201,))
            cur.execute("SELECT count(*) FROM public.orders")
            orders = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM public.customers")
            customers = cur.fetchone()[0]
            cur.execute("SELECT order_id FROM public.orders ORDER BY order_id LIMIT 1")
            row = cur.fetchone()
            order_id = row[0] if row else None
            cur.execute("SELECT customer_id FROM public.customers ORDER BY customer_id DESC LIMIT 1")
            row = cur.fetchone()
            customer_id = row[0] if row else None
            action = operation(tick, orders, customers, max_orders, max_customers)
            cur.execute(*statement(action, order_id, customer_id, tick, email_domain))
            return action


def main():
    try:
        interval, max_orders, max_customers, log_every, email_domain = config()
    except (ValueError, OverflowError):
        print("invalid shop generator configuration", flush=True)
        return 2
    import psycopg2

    conn = None
    tick = 0
    delay = 1
    while True:
        try:
            if conn is None:
                conn = psycopg2.connect(connect_timeout=5, options="-c statement_timeout=10000 -c lock_timeout=5000")
            action = write_once(conn, tick, max_orders, max_customers, email_domain)
            tick += 1
            delay = 1
            if tick % log_every == 0:
                print(f"shop writes={tick} last={action}", flush=True)
            time.sleep(interval)
        except psycopg2.Error as error:
            # D-SHOP-3: retry startup/schema/credential reconciliation and DB outages.
            # Cost: errors need log monitoring; escape hatch: invalid local config exits 2.
            # Never log exception text: connection diagnostics may contain credentials.
            print(f"shop database retry type={type(error).__name__} delay={delay}s", flush=True)
            if conn is not None:
                conn.close()
                conn = None
            time.sleep(delay)
            delay = min(delay * 2, 60)


if __name__ == "__main__":
    raise SystemExit(main())
