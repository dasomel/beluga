"""Opt-in live CDC lifecycle check. No live operations occur on import."""
import json
import signal
import subprocess
import time
import uuid

from live_checks import internal_query, kubectl


def event_matches(line, order_id, marker):
    try:
        key, value = (json.loads(part) for part in line.split('\t', 1))
        key = key.get('payload', key)
        value = value.get('payload', value)
        return (key['order_id'] == order_id and value['op'] == 'c'
                and value['after']['order_id'] == order_id
                and value['after']['status'] == marker)
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def wait_for(hop, observe, expected, seconds=240):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        last = observe()
        if last == expected:
            print(f'PASS: {hop}', flush=True)
            return
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise RuntimeError(f'{hop}: timeout after {seconds}s; last={last!r}')


def main():
    marker = 'e2e_' + uuid.uuid4().hex[:16]  # VARCHAR(20), distinct from demo statuses.
    inserted = False

    def sql(statement):
        cluster = json.loads(kubectl('-n', 'database', 'get', 'cluster', 'postgres-main', '-o', 'json'))
        return kubectl('-n', 'database', 'exec', cluster['status']['currentPrimary'],
                       '-c', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                       '-U', 'postgres', '-d', 'shop', '-Atc', statement).strip()

    def cleanup():
        if inserted:
            # D-PIPE-4: cleanup by unique marker even when INSERT's reply is lost.
            # Cost: retained CDC delete event; escape: operator removes logged marker if DB unavailable.
            try:
                sql(f"DELETE FROM public.orders WHERE status = '{marker}'")
                print(f'PASS: source cleanup marker={marker}', flush=True)
            except (OSError, subprocess.SubprocessError) as exc:
                raise RuntimeError(f'cleanup failed; remove source marker={marker}') from exc

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    print(f'marker={marker}', flush=True)
    hop = 'Debezium connector/task'
    try:
        status = json.loads(kubectl('-n', 'streaming', 'exec', 'deploy/debezium-connect', '--',
                                    'curl', '-fsS', '--max-time', '20',
                                    'http://localhost:8083/connectors/shop-cdc/status'))
        if (status['connector']['state'] != 'RUNNING' or not status['tasks']
                or any(task['state'] != 'RUNNING' for task in status['tasks'])):
            raise RuntimeError('connector/tasks not RUNNING')
        print(f'PASS: {hop}', flush=True)

        def kafka(tool, *args, timeout=60):
            return kubectl('-n', 'streaming', 'exec', 'beluga-kafka-mixed-0', '--',
                           '/opt/kafka/bin/' + tool + '.sh', '--bootstrap-server',
                           'localhost:9092', *args, timeout=timeout)

        hop = 'Kafka starting offsets'
        offsets = kafka('kafka-get-offsets', '--topic', 'cdc.shop.public.orders', '--time', '-1')
        partitions = []
        for line in offsets.splitlines():
            topic, partition, offset = line.split(':')
            if topic != 'cdc.shop.public.orders' or not partition.isdecimal() or not offset.isdecimal():
                raise ValueError('invalid Kafka offset response')
            partitions.append((partition, offset))
        if not partitions:
            raise ValueError('no Kafka partitions')
        hop = 'Postgres INSERT'
        # SERIAL allocates an unused key; NULL customer_id is allowed by the schema.
        # Register cleanup before sending INSERT, including uncertain exec outcomes.
        inserted = True
        result = sql(f"INSERT INTO public.orders (total_amount, status) VALUES (12.34, '{marker}') "
                     "RETURNING order_id")
        order_id = int(result.splitlines()[0])
        print(f'PASS: {hop} order_id={order_id}', flush=True)
        hop = 'Postgres -> Debezium -> Kafka keyed INSERT'

        def event_seen():
            for partition, offset in partitions:
                # D-PIPE-5: explicit pre-insert offsets avoid consumer startup races and
                # historical false positives. Cost: bounded replay; escape: isolated demo topic.
                args = ['kubectl', '--request-timeout=30s', '-n', 'streaming', 'exec',
                        'beluga-kafka-mixed-0', '--', '/opt/kafka/bin/kafka-console-consumer.sh',
                        '--bootstrap-server', 'localhost:9092', '--topic', 'cdc.shop.public.orders',
                        '--partition', partition, '--offset', offset, '--timeout-ms', '10000',
                        '--max-messages', '10000', '--property', 'print.key=true']
                proc = subprocess.run(args, text=True, capture_output=True, timeout=30)
                # Kafka console consumer exits nonzero on its idle timeout. Accept only
                # that documented timeout or success, and still require the exact event.
                if proc.returncode and 'TimeoutException' not in proc.stderr:
                    raise RuntimeError('Kafka consumer failed: ' + proc.stderr[-1000:])
                if any(event_matches(line, order_id, marker) for line in proc.stdout.splitlines()):
                    return True
            return False

        wait_for(hop, event_seen, True, seconds=90)
        statement = ("SELECT status, CAST(total_amount AS varchar) FROM iceberg.lake.orders "
                     f'WHERE order_id = {order_id}')
        hop = 'Kafka -> Flink -> Iceberg INSERT'
        wait_for(hop, lambda: internal_query(statement, timeout=30), [[marker, '12.34']])
        hop = 'Postgres UPDATE'
        if sql(f"UPDATE public.orders SET total_amount=56.78, updated_at=NOW() "
               f"WHERE order_id={order_id} AND status='{marker}'") != 'UPDATE 1':
            raise RuntimeError('expected UPDATE 1')
        hop = 'CDC -> Iceberg UPDATE (one PK row)'
        wait_for(hop, lambda: internal_query(statement, timeout=30), [[marker, '56.78']])
        hop = 'Postgres DELETE'
        if sql(f"DELETE FROM public.orders WHERE order_id={order_id} AND status='{marker}'") != 'DELETE 1':
            raise RuntimeError('expected DELETE 1')
        hop = 'CDC -> Iceberg DELETE'
        wait_for(hop, lambda: internal_query(statement, timeout=30), [])
    except Exception as exc:
        raise RuntimeError(f'FAIL hop={hop}: {exc}') from exc
    finally:
        cleanup()


if __name__ == '__main__':
    main()
