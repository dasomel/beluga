#!/usr/bin/env python3
"""Generate/check the offline SQL column-lineage report (Issue #88)."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/lineage'))
from sql_lineage import parse  # noqa: E402

REPORT = Path('docs/generated/column-lineage.json')


def generate(root):
    paths = sorted(set(root.glob('gitops/**/*.sql')) | set(root.glob('sql/**/*.sql')))
    if not paths:
        raise ValueError('no SQL input files found')
    inputs, transformations = [], []
    for path in paths:
        data = path.read_bytes()
        relative = path.relative_to(root).as_posix()
        inputs.append({'path': relative, 'sha256': hashlib.sha256(data).hexdigest()})
        for transformation in parse(data.decode('utf-8')):
            transformation['path'] = relative
            transformations.append(transformation)
    return {'version': 1, 'extractor_version': 1, 'source': 'static',
            'confidence': 'supported-syntax-with-declared-schema',
            'inputs': inputs, 'transformations': transformations}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, help='write JSON (default: stdout)')
    parser.add_argument('--check', action='store_true', help='compare against committed report')
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        report = generate(root)
        text = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
        if args.check:
            expected = args.output or root / REPORT
            if expected.read_text(encoding='utf-8') != text:
                raise ValueError(f'stale or tampered report: {expected}; regenerate it')
            print(f"PASS: column lineage report matches {len(report['inputs'])} SQL files, {len(report['transformations'])} transformations")
        elif args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text, encoding='utf-8')
        else:
            print(text, end='')
        return 0
    except (OSError, ValueError, IndexError) as exc:
        print(f'column lineage FAIL: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
