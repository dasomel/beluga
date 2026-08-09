-- CNPG Shop Database Schema & Initial Seed Data

CREATE TABLE IF NOT EXISTS customers (
    customer_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    city VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    order_id SERIAL PRIMARY KEY,
    customer_id INT REFERENCES customers(customer_id),
    total_amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed Data
INSERT INTO customers (name, email, city) VALUES
('Alice Kim', 'alice@beluga.local', 'Seoul'),
('Bob Lee', 'bob@beluga.local', 'Busan'),
('Charlie Park', 'charlie@beluga.local', 'Incheon')
ON CONFLICT (email) DO NOTHING;

INSERT INTO orders (customer_id, total_amount, status) VALUES
(1, 150.00, 'COMPLETED'),
(2, 89.50, 'PENDING'),
(3, 210.00, 'SHIPPED')
ON CONFLICT DO NOTHING;
