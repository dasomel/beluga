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
    # D-SHOP-11: delete owned rows only above cap, once per ten ticks.
    # Cost: metadata column + one-row overshoot / slow drain; escape hatch: lower cap or interval.
    if orders > max_orders:
        return "delete_order" if tick % 10 == 5 else "update_order"
    if customers == 0:
        return "insert_customer"
    slot = tick % 10
    if slot == 8 and customers < max_customers:
        return "insert_customer"
    if slot == 9 or slot == 8:
        return "update_customer"
    if slot in (1, 2, 4, 7) and orders:
        return "update_order"
    return "insert_order"


SQL = {
    "insert_customer": "INSERT INTO public.customers (name, email, city) VALUES (%s, %s, %s)",
    # D-SHOP-13: UUID-hex email local parts mark generated customers across name updates.
    # Cost: reserve this email pattern; escape hatch: explicit ownership column if shared.
    "update_customer": "UPDATE public.customers SET name = %s, city = %s WHERE customer_id = %s AND email ~ '^[0-9a-f]{32}@'",
    "insert_order": "INSERT INTO public.orders (customer_id, total_amount, status, generator_owned) VALUES (%s, %s, %s, true)",
    # D-SHOP-14: orders follow PENDING -> SHIPPED -> COMPLETED (or PENDING -> CANCELLED) and keep
    # their amount; terminal orders are never rewritten. Random status/amount rewrites made
    # Gold revenue meaningless (an order's value changed on shipping, COMPLETED went back to PENDING).
    # Cost: deterministic, simplified lifecycle; escape hatch: richer state machine if needed.
    "update_order": (
        "UPDATE public.orders SET status = CASE status WHEN 'PENDING' THEN %s ELSE 'COMPLETED' END, "
        "updated_at = CURRENT_TIMESTAMP "
        "WHERE order_id = %s AND generator_owned = true AND status IN ('PENDING', 'SHIPPED')"
    ),
    "delete_order": "DELETE FROM public.orders WHERE order_id = %s AND generator_owned = true",
}


def statement(action, order_id, customer_id, tick, email_domain):
    amount = Decimal(random.randint(100, 50000)) / 100
    # Cancellation is a fixed tick pattern, not a probability: a pending order is cancelled when its
    # update lands on tick % 8 == 7. The realised share depends on which ticks are updates
    # (about 18-25% of orders in simulation).
    after_pending = "CANCELLED" if tick % 8 == 7 else "SHIPPED"
    city = ("Seoul", "Busan", "Incheon")[tick % 3]
    params = {
        "insert_customer": ("Demo shopper", uuid.uuid4().hex + "@" + email_domain, city),
        "update_customer": ("Demo shopper " + str(tick % 100), city, customer_id),
        "insert_order": (customer_id, amount, "PENDING"),
        "update_order": (after_pending, order_id),
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
            action = operation(tick, orders, customers, max_orders, max_customers)
            # Updates advance the oldest open order; deletes drain the oldest owned order.
            if action == "update_order":
                cur.execute("SELECT order_id FROM public.orders WHERE generator_owned = true "
                            "AND status IN ('PENDING', 'SHIPPED') ORDER BY order_id LIMIT 1")
            else:
                cur.execute("SELECT order_id FROM public.orders WHERE generator_owned = true ORDER BY order_id LIMIT 1")
            row = cur.fetchone()
            order_id = row[0] if row else None
            cur.execute("SELECT customer_id FROM public.customers ORDER BY customer_id DESC LIMIT 1")
            row = cur.fetchone()
            customer_id = row[0] if row else None
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
            if delay == 60:
                return 1
            time.sleep(delay)
            delay = min(delay * 2, 60)


if __name__ == "__main__":
    raise SystemExit(main())
