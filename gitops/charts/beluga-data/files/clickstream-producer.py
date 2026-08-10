#!/usr/bin/env python3
"""Synthetic Clickstream Generator (Kafka Producer)."""

import json
import os
import random
import time
from datetime import datetime
from kafka import KafkaProducer


def get_producer():
    bootstrap_servers = os.getenv(
        "KAFKA_BOOTSTRAP", "beluga-kafka-kafka-bootstrap:9092"
    )
    return KafkaProducer(
        bootstrap_servers=bootstrap_servers,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    )


def generate_event():
    user_ids = [f"user_{i}" for i in range(1, 20)]
    pages = ["/home", "/product/detail", "/cart", "/checkout", "/search"]
    actions = ["view", "click", "add_to_cart", "purchase"]

    return {
        "event_id": f"evt_{int(time.time() * 1000)}_{random.randint(1000, 9999)}",
        "user_id": random.choice(user_ids),
        "page": random.choice(pages),
        "action": random.choice(actions),
        "timestamp": datetime.utcnow().isoformat(),
        "duration_ms": random.randint(100, 5000),
    }


if __name__ == "__main__":
    print("Starting Clickstream Event Producer...")
    producer = get_producer()
    topic = "events.clickstream"

    while True:
        event = generate_event()
        producer.send(topic, value=event)
        producer.flush()
        print(f"Produced event to {topic}: {event}")
        time.sleep(1)
