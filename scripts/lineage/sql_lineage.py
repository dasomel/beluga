"""Conservative SQL subset parser; no execution or external dependencies."""

import re

TOKEN = re.compile(r"--[^\n]*|/\*[\s\S]*?\*/|'(?:[^']|'')*'|`(?:[^`]|``)*`|\"(?:[^\"]|\"\")*\"|[A-Za-z_][\w$]*|\d+(?:\.\d+)?|\s+|.")
IDENT = re.compile(r'^[a-z_][\w$]*$')
FUNCTIONS = {'cast', 'replace', 'sum', 'count', 'min', 'max', 'avg', 'coalesce', 'nullif', 'upper', 'lower', 'trim', 'abs', 'round', 'tumble_start', 'tumble_end'}
WORDS = set('as distinct null true false case when then else end and or not is in between like interval second minute hour day int integer bigint string varchar decimal double float boolean date timestamp'.split())


def tokens(sql):
    result = []
    for match in TOKEN.finditer(sql):
        token = match.group()
        if token.isspace() or token.startswith(('--', '/*')):
            continue
        result.append(token if token[0] in "'`\"" else token.lower())
    return result


def identifier(token):
    return bool(IDENT.fullmatch(token)) or token.startswith(('`', '"'))


def name(token):
    return token[1:-1].replace(token[0] * 2, token[0]) if token.startswith(('`', '"')) else token


def split(items, delimiter=','):
    parts, start, depth = [], 0, 0
    for i, token in enumerate(items):
        if token == '(':
            depth += 1
        elif token == ')':
            depth -= 1
        elif token == delimiter and depth == 0:
            parts.append(items[start:i])
            start = i + 1
    parts.append(items[start:])
    return [part for part in parts if part]


def closing(items, start):
    depth = 0
    for i in range(start, len(items)):
        depth += (items[i] == '(') - (items[i] == ')')
        if depth == 0:
            return i
    raise ValueError('unbalanced parentheses')


def object_name(items, start):
    if start >= len(items) or not identifier(items[start]):
        raise ValueError('expected SQL identifier')
    parts = [name(items[start])]
    end = start + 1
    while end + 1 < len(items) and items[end] == '.' and identifier(items[end + 1]):
        parts.append(name(items[end + 1]))
        end += 2
    return '.'.join(parts), end


def schema(statement):
    if statement[:2] != ['create', 'table']:
        return None
    start = 5 if statement[2:5] == ['if', 'not', 'exists'] else 2
    table, start = object_name(statement, start)
    if start >= len(statement) or statement[start] != '(':
        return None
    fields = split(statement[start + 1:closing(statement, start)])
    columns = [name(field[0]) for field in fields if identifier(field[0]) and field[0] not in {'primary', 'constraint', 'watermark', 'unique', 'foreign', 'check'}]
    return table, columns


def sources(items):
    """Read a flat FROM/JOIN list, rejecting nested or schema-merging syntax."""
    if any(t in items for t in ('(', ')', 'using', 'natural', 'lateral', 'unnest')):
        raise ValueError('unsupported FROM/subquery/USING/NATURAL join')
    result, i, expect = {}, 0, True
    while i < len(items):
        if expect:
            table, i = object_name(items, i)
            alias = table.split('.')[-1]
            if i < len(items) and items[i] == 'as':
                i += 1
                if i >= len(items) or not identifier(items[i]):
                    raise ValueError('missing source alias')
                alias, i = name(items[i]), i + 1
            elif i < len(items) and identifier(items[i]) and items[i] not in {'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on'}:
                alias, i = name(items[i]), i + 1
            if alias in result:
                raise ValueError('duplicate source alias')
            result[alias] = table
            expect = False
        elif items[i] in ('join', ','):
            expect, i = True, i + 1
        else:
            i += 1
    if expect or not result:
        raise ValueError('missing source relation')
    return result


def expression(items, relations, schemas):
    refs, reasons, i = set(), [], 0
    while i < len(items):
        token = items[i]
        if token == '*' and (i == 0 or items[i - 1] in ('(', '.')):
            reasons.append('wildcard requires expansion')
        if identifier(token):
            if i + 1 < len(items) and items[i + 1] == '(':
                if token not in FUNCTIONS and not (i > 0 and items[i - 1] == 'as' and token in WORDS):
                    reasons.append('unsupported function: ' + token)
                i += 1
                continue
            if token in WORDS and (i > 0 and items[i - 1] == 'as' or not any(token in schemas.get(table, []) for table in relations.values())):
                i += 1
                continue
            ref, end = object_name(items, i)
            parts = ref.split('.')
            column = parts[-1]
            if len(parts) > 1:
                qualifier = '.'.join(parts[:-1])
                candidates = [table for alias, table in relations.items() if qualifier in (alias, table)]
            else:
                # D1: require DDL for every candidate, avoiding guessed join ownership.
                # Cost: external schemas are unknown; add a schema adapter to extend coverage.
                if any(table not in schemas for table in relations.values()):
                    reasons.append('missing source schema')
                candidates = [table for table in relations.values() if column in schemas.get(table, [])]
            if len(candidates) != 1 or column not in schemas.get(candidates[0], []):
                reasons.append('unresolved or ambiguous column: ' + ref)
            else:
                refs.add((candidates[0], column))
            i = end
        else:
            if token not in {'(', ')', ',', '+', '-', '*', '/', '%', '=', '<', '>', '!', '|'} and not token.startswith("'") and not re.fullmatch(r'\d+(?:\.\d+)?', token):
                reasons.append('unsupported expression token: ' + token)
            i += 1
    # D2: partial references are not complete lineage. Cost: less coverage;
    # extend the supported grammar rather than presenting partial edges as resolved.
    return ([] if reasons else [{'dataset': table, 'column': col} for table, col in sorted(refs)], sorted(set(reasons)))


def extract(statement, schemas):
    is_insert = statement[:2] == ['insert', 'into']
    prefix = 2 if is_insert else 4 if statement[:4] == ['create', 'or', 'replace', 'view'] else 2
    target, pos = object_name(statement, prefix)
    result = {'target': target, 'status': 'unknown', 'columns': [], 'reasons': []}
    try:
        targets = None
        if pos < len(statement) and statement[pos] == '(':
            end = closing(statement, pos)
            fields = split(statement[pos + 1:end])
            if any(len(f) != 1 or not identifier(f[0]) for f in fields):
                raise ValueError('unsupported target column list')
            targets = [name(f[0]) for f in fields]
            if is_insert and target in schemas and any(c not in schemas[target] for c in targets):
                raise ValueError('unknown target column')
            pos = end + 1
        if not is_insert:
            if statement[pos:pos + 1] != ['as']:
                raise ValueError('view requires AS SELECT')
            pos += 1
        if statement[pos:pos + 1] != ['select']:
            raise ValueError('unsupported query (requires SELECT)')
        query = statement[pos + 1:]
        if any(t in query for t in ('select', 'union', 'intersect', 'except', 'over', 'with')):
            raise ValueError('unsupported nested/window/set query')
        depth, from_pos = 0, None
        for i, token in enumerate(query):
            depth += (token == '(') - (token == ')')
            if token == 'from' and depth == 0:
                from_pos = i
                break
        if from_pos is None:
            raise ValueError('missing FROM')
        end = next((i for i in range(from_pos + 1, len(query)) if query[i] in {'where', 'group', 'having', 'order', 'limit'}), len(query))
        relations = sources(query[from_pos + 1:end])
        projections = split(query[:from_pos])
        if not projections:
            raise ValueError('empty SELECT projection')
        if projections and projections[0][0] == 'distinct':
            projections[0] = projections[0][1:]
        targets = targets if targets is not None else schemas.get(target) if is_insert else None
        if targets is not None and len(targets) != len(projections):
            raise ValueError('target/projection arity mismatch')
        for index, projection in enumerate(projections):
            alias = None
            if len(projection) >= 2 and projection[-2] == 'as' and identifier(projection[-1]):
                alias, projection = name(projection[-1]), projection[:-2]
            elif len(projection) >= 2 and identifier(projection[-1]) and projection[-2] not in {'.', '+', '-', '*', '/', '%'} and projection[-1] not in WORDS:
                alias, projection = name(projection[-1]), projection[:-1]
            column = targets[index] if targets is not None else alias
            if column is None and not is_insert:
                ref, consumed = object_name(projection, 0)
                if consumed == len(projection):
                    column = ref.split('.')[-1]
            refs, reasons = expression(projection, relations, schemas)
            if not projection:
                reasons.append('empty output expression')
            if column is None:
                reasons.append('missing target schema or output alias')
            result['columns'].append({'target_column': column, 'expression': ' '.join(projection), 'sources': refs if not reasons else [], 'status': 'unknown' if reasons else 'resolved', 'reasons': reasons})
        result['status'] = 'unknown' if any(c['status'] == 'unknown' for c in result['columns']) else 'resolved'
    except (ValueError, IndexError) as exc:
        result['reasons'] = [str(exc) or 'incomplete SQL']
    return result


def parse(sql):
    statements = split(tokens(sql), ';')
    schemas = {}
    for statement in statements:
        entry = schema(statement)
        if entry:
            schemas[entry[0]] = entry[1]
    results = []
    for index, statement in enumerate(statements):
        if statement[:2] == ['insert', 'into'] or statement[:2] == ['create', 'view'] or statement[:4] == ['create', 'or', 'replace', 'view']:
            # VALUES are seed data, not a SELECT transformation.
            if statement[:2] == ['insert', 'into'] and 'select' not in statement and 'values' in statement:
                continue
            result = extract(statement, schemas)
            result['statement'] = index + 1
            results.append(result)
    return results
