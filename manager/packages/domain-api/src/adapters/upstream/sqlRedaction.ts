// Conservative literal redaction for SQL text shown in query history. Not a SQL parser and not a
// security boundary on its own: it replaces string literals and numeric literals with `?` and drops
// comments, keeping identifiers (double-quoted ones are kept verbatim). Unterminated constructs are
// redacted to the end of input (fail closed).
export function redactSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += "?";
    } else if (ch === '"') {
      const start = i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
    } else if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(out.slice(-1))) {
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i] as string)) i++;
      out += "?";
    } else {
      out += ch;
      i++;
    }
  }
  return out.trim();
}
