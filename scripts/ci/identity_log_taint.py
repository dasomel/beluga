"""Bounded, name-seeded taint analysis for rendered inline bootstrap scripts."""
import ast
import re
import shlex


SECRET_NAME = re.compile(r"secret|password|token|credential|(?:^|_)pass(?:$|_)", re.I)
SHELL_VAR = re.compile(r"\$(?:\{([A-Za-z_]\w*)[^}]*\}|([A-Za-z_]\w*))")
STRING_METHODS = frozenset(dir(str)) - {"__class__", "__new__"}


def dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{dotted(node.value)}.{node.attr}"
    return ""


def python_log_lines(tree: ast.AST) -> list[int]:
    aliases: set[str] = set()
    fields: dict[str, dict[str, bool]] = {}

    def shape(node: ast.AST) -> dict[str, bool] | None:
        if isinstance(node, ast.Name):
            return fields.get(node.id)
        if isinstance(node, ast.Dict) and all(isinstance(k, ast.Constant) and isinstance(k.value, str) for k in node.keys):
            return {k.value: sensitive(v) for k, v in zip(node.keys, node.values)}
        if isinstance(node, (ast.List, ast.Tuple)):
            shapes = [shape(element) for element in node.elts]
            if shapes and all(item is not None for item in shapes):
                keys = set().union(*(item.keys() for item in shapes))
                return {key: any(item.get(key, False) for item in shapes) for key in keys}
        return None

    def sensitive(node: ast.AST) -> bool:
        if isinstance(node, ast.Name):
            return bool(SECRET_NAME.search(node.id) or node.id in aliases)
        if isinstance(node, ast.Call):
            name = dotted(node.func)
            # D3 (#389): Request arguments must not taint response status/body.
            # Cost: unknown helper returns are opaque; extend this allowlist and
            # its fixtures when another value-deriving operation is introduced.
            if name in {"str", "repr", "format", "len", "json.dumps"} or name.startswith(("hashlib.", "base64.")):
                return any(sensitive(arg) for arg in node.args) or any(sensitive(k.value) for k in node.keywords)
            if isinstance(node.func, ast.Attribute):
                method = node.func.attr
                if method in {"keys", "items"}:
                    return False
                if method in STRING_METHODS or method in {"encode", "decode", "hexdigest", "digest"}:
                    return sensitive(node.func.value) or any(sensitive(a) for a in node.args) or any(
                        sensitive(k.value) for k in node.keywords)
                if method == "get" and node.args and isinstance(node.args[0], ast.Constant):
                    key = str(node.args[0].value)
                    known = shape(node.func.value)
                    return bool(SECRET_NAME.search(key)) or (
                        known[key] if known is not None and key in known else sensitive(node.func.value)
                    ) or any(sensitive(a) for a in node.args[1:])
            return False
        if isinstance(node, ast.Subscript):
            if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
                if SECRET_NAME.search(node.slice.value):
                    return True
                known = shape(node.value)
                if known is not None and node.slice.value in known:
                    return known[node.slice.value]
        return any(sensitive(child) for child in ast.iter_child_nodes(node))

    def bind(target: ast.AST, value: ast.AST, force: bool = False) -> None:
        if isinstance(target, (ast.Tuple, ast.List)):
            if isinstance(value, (ast.Tuple, ast.List)) and len(target.elts) == len(value.elts):
                for left, right in zip(target.elts, value.elts):
                    bind(left, right, force)
            else:
                for child in target.elts:
                    bind(child, value, force)
        elif isinstance(target, ast.Starred):
            bind(target.value, value, force)
        else:
            known = shape(value)
            if isinstance(target, ast.Name) and known is not None:
                previous = fields.setdefault(target.id, {})
                for key, tainted in known.items():
                    previous[key] = previous.get(key, False) or tainted
            if not (force or sensitive(value)):
                return
            if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
                previous = fields.get(target.value.id)
                if previous is not None:
                    if isinstance(target.slice, ast.Constant) and isinstance(target.slice.value, str):
                        previous[target.slice.value] = True
                    else:
                        for key in previous:
                            previous[key] = True
            # Mutated containers/attributes retain taint through their root name.
            while isinstance(target, (ast.Subscript, ast.Attribute)):
                target = target.value
            if isinstance(target, ast.Name):
                aliases.add(target.id)

    def bind_iteration(target: ast.AST, value: ast.AST) -> None:
        # D4 (#389): Mapping keys are public client IDs, values may be secrets.
        # Cost: monotone, scope-insensitive aliases may overreport; literal field
        # shapes, unpacking and items()/keys() preserve public fields. Extend shape
        # handling with fixtures if future workloads use another container idiom.
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute):
            if value.func.attr == "keys":
                return
            if value.func.attr == "items" and isinstance(target, (ast.Tuple, ast.List)) and len(target.elts) == 2:
                bind(target.elts[1], value.func.value)
                return
        if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
            for element in value.elts:
                bind(target, element)
        else:
            bind(target, value)

    nodes = list(ast.walk(tree))
    while True:
        before = (aliases.copy(), {name: value.copy() for name, value in fields.items()})
        for node in nodes:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    bind(target, node.value)
            elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and node.value is not None:
                bind(node.target, node.value)
            elif isinstance(node, ast.AugAssign):
                bind(node.target, node.value, sensitive(node.target))
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                bind_iteration(node.target, node.iter)
        if (aliases, fields) == before:
            break

    def output(node: ast.Call) -> bool:
        name = dotted(node.func)
        return (name == "print" or name in {"sys.stdout.write", "sys.stderr.write"}
                or name.startswith("logging."))

    return sorted({node.lineno for node in nodes if isinstance(node, ast.Call) and output(node)
                   and (any(sensitive(a) for a in node.args)
                        or any(sensitive(k.value) for k in node.keywords if k.arg != "file"))})


def shell_log_lines(source: str) -> list[int]:
    aliases: set[str] = set()
    commands: list[tuple[int, list[str]]] = []
    # D5 (#389): Tokenize shell conservatively; explicit file writes are payloads,
    # fd 1/2 redirections remain logs. Cost: no shell execution/expansion model;
    # add fixtures before extending recognized commands or redirection syntax.
    logical_lines: list[tuple[int, str]] = []
    pending = ""
    start = 1
    for number, line in enumerate(source.splitlines(), 1):
        if not pending:
            start = number
        pending += line
        if pending.endswith("\\"):
            pending = pending[:-1] + " "
            continue
        logical_lines.append((start, pending))
        pending = ""
    if pending:
        logical_lines.append((start, pending))
    for number, line in logical_lines:
        try:
            lexer = shlex.shlex(line, posix=False, punctuation_chars=";&|<>")
            lexer.whitespace_split = True
            parts = list(lexer)
        except ValueError:
            continue
        command: list[str] = []
        for part in parts + [";"]:
            if part in {";", "&&", "||", "|", "&"}:
                if command:
                    commands.append((number, command))
                command = []
            else:
                command.append(part)

    def sensitive(word: str) -> bool:
        # Single-quoted shell text never expands variables.
        expanded = []
        quote = ""
        escaped = False
        for char in word:
            if escaped:
                expanded.append(" " if char == "$" else char)
                escaped = False
            elif char == "\\" and quote != "'":
                escaped = True
            elif char in {"'", '"'} and (not quote or quote == char):
                quote = "" if quote else char
            elif quote != "'":
                expanded.append(char)
        word = "".join(expanded)
        return any(SECRET_NAME.search(a or b) or (a or b) in aliases for a, b in SHELL_VAR.findall(word))

    while True:
        before = aliases.copy()
        for _, parts in commands:
            for part in parts:
                match = re.match(r"^([A-Za-z_]\w*)=(.*)$", part)
                if match and sensitive(match[2]):
                    aliases.add(match[1])
        if before == aliases:
            break

    lines = set()
    for number, parts in commands:
        names = [part.strip("\"'").rsplit("/", 1)[-1] for part in parts]
        sink = any(name in {"echo", "printf"} for name in names) or ("cat" in names and "<<<" in parts)
        if not sink or not any(sensitive(part) for part in parts):
            continue
        file_output = False
        for i, part in enumerate(parts[:-1]):
            if part in {">", ">>", ">&", "&>", "&>>"}:
                destination = parts[i + 1].strip("\"'")
                # A stderr-only file redirect does not suppress stdout output.
                stderr_only = i > 0 and parts[i - 1] == "2" and part in {">", ">>"}
                if not stderr_only:
                    file_output = destination not in {"1", "2", "/dev/stdout", "/dev/stderr", "/dev/fd/1", "/dev/fd/2"}
        if not file_output:
            lines.add(number)
    return sorted(lines)


def secret_log_lines(source: str) -> list[int]:
    """Detect inline Python/shell secret outputs, without executing either language.

    External scripts, dynamic eval, arbitrary helper returns and interprocedural
    flow remain outside this bounded analysis.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return shell_log_lines(source)
    return python_log_lines(tree)
