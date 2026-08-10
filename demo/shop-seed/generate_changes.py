#!/usr/bin/env python3
"""CDC Test Seed & Change Generator for CNPG Shop DB."""

import os
import random
import time
import psycopg2


def get_connection():
    host = os.getenv("POSTGRES_HOST", "postgres-main-rw")
    port = os.getenv("POSTGRES_PORT", "5432")
    user = os.getenv("POSTGRES_USER", "beluga_admin")
    # D15: 비밀번호 기본값 없음 — 부트스트랩이 생성한 secret에서 주입해야 함
    # (kubectl -n beluga-data get secret postgres-admin-credential -o jsonpath='{.data.password}' | base64 -d)
    password = os.environ["POSTGRES_PASSWORD"]
    dbname = os.getenv("POSTGRES_DB", "shop")
    return psycopg2.connect(
        host=host, port=port, user=user, password=password, dbname=dbname
    )


def apply_changes():
    conn = get_connection()
    cursor = conn.cursor()

    statuses = ["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]

    # 1. Update order status
    order_id = random.randint(1, 3)
    new_status = random.choice(statuses)
    cursor.execute(
        "UPDATE orders SET status = %s, updated_at = CURRENT_TIMESTAMP WHERE order_id = %s",
        (new_status, order_id),
    )

    # 2. Insert new order
    cust_id = random.randint(1, 3)
    amount = round(random.uniform(10.0, 500.0), 2)
    cursor.execute(
        "INSERT INTO orders (customer_id, total_amount, status) VALUES (%s, %s, 'PENDING')",
        (cust_id, amount),
    )

    conn.commit()
    cursor.close()
    conn.close()
    print(f"Applied CDC test change: Order {order_id} status -> {new_status}")


if __name__ == "__main__":
    print("Starting CNPG Shop DB CDC Change Generator loop...")
    while True:
        try:
            apply_changes()
        except Exception as e:
            print(f"Error generating changes: {e}")
        time.sleep(5)
