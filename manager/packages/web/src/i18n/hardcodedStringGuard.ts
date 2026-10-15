import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  isArrayLiteralExpression,
  isBinaryExpression,
  isConditionalExpression,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxText,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isStringLiteral,
  isTemplateExpression,
  SyntaxKind,
  type JsxAttribute,
  type JsxChild,
  type JsxText,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type SourceFile,
  type StringLiteral,
} from 'typescript/unstable/ast';
import { createVirtualFileSystem, type FileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';

// This module is the CI gate for issue #44: it statically finds new hardcoded user-facing
// strings in packages/web/src so that i18n coverage can't silently regress after the
// getTranslations.test.ts key-parity check passes. It uses the TypeScript compiler API
// (already a project dependency -- no new dependency) instead of regex so that JSX
// structure (text vs. attribute vs. className) is understood rather than pattern-matched.
//
// D1: TypeScript 7's package no longer exposes the classic `ts.createSourceFile` /
// `ts.forEachChild` namespace from its root import -- that logic now lives entirely behind
// the native `tsgo` binary, reachable only through `typescript/unstable/sync`'s API/Project/
// Program client. AST node types and `is*` predicates still ship as plain TS from
// `typescript/unstable/ast`. Cost: every scan spawns the native binary once (batched across
// all files opened in one snapshot, ~0.2s for the whole package). Escape hatch: if a future
// typescript release restores a synchronous in-process parse entry point, `openProject`/
// `openFixtures` below are the only two functions that need to change.

export interface HardcodedStringViolation {
  /** Path relative to the web package root, e.g. "src/App.tsx". Always forward-slashed. */
  file: string;
  line: number;
  column: number;
  kind: 'jsx-text' | 'jsx-attribute' | 'invalid-exempt-marker';
  attribute?: string;
  text: string;
}

export interface BaselineEntry {
  file: string;
  line: number;
  text: string;
  reason: string;
}

// Attributes that are structural/wiring, not prose shown to a person. Their string value can
// legitimately contain letters (className words, ids, hrefs, test ids) without being
// translatable content. Matched case-insensitively.
const STRUCTURAL_ATTRIBUTES = new Set([
  'classname', 'class', 'style', 'id', 'key', 'href', 'src', 'srcset', 'rel', 'target',
  'type', 'name', 'htmlfor', 'for', 'role', 'tabindex', 'colspan', 'rowspan', 'value',
  'action', 'method', 'x', 'y', 'width', 'height', 'fill', 'viewbox', 'xmlns',
]);

// User-facing attributes whose literal string value is prose a person reads and must
// therefore be routed through the translation catalogs. Anything ending in "label" also
// counts (ariaLabel, relatedServiceLabel, ...) per the "label-like props" rule in issue #44.
const USER_FACING_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label']);

function isStructuralAttribute(lowerName: string): boolean {
  if (STRUCTURAL_ATTRIBUTES.has(lowerName)) return true;
  if (lowerName.startsWith('data-')) return true;
  if (lowerName.includes('testid') || lowerName.includes('test-id')) return true;
  if (lowerName.startsWith('aria-') && lowerName !== 'aria-label') return true;
  return false;
}

function isUserFacingAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  if (isStructuralAttribute(lower)) return false;
  return USER_FACING_ATTRIBUTES.has(lower) || lower.endsWith('label');
}

const HAS_LETTER = /\p{L}/u;
// HTML entity refs (&bull;, &rarr;, ...) are punctuation glyphs, not prose, but their name
// (e.g. "bull") is itself made of letters -- so they must be stripped *before* the
// has-a-letter check, or a text node that is only "&bull;" separators would be misread as
// containing the word "bull".
const HTML_ENTITY_REF = /&[a-zA-Z]+;/g;
const EXEMPT_MARKER = /i18n-exempt:?\s*([^*]*)/i;
// A marker with no reason, or a reason too short to be an actual justification (e.g. "ok"),
// is worse than no marker at all -- it looks reviewed but was not. Below this length the
// marker does not exempt anything, and the marker itself is reported as its own violation
// (see `collectInvalidExemptMarkers`) so the misuse is visible in the gate's own output.
const MIN_EXEMPT_REASON_LENGTH = 8;

/** Returns the trimmed text if it looks like translatable prose, otherwise null. Numbers,
 *  punctuation, symbols, and HTML entity refs alone (e.g. "42%", "3.14", "&bull;") are not
 *  prose per issue #44's exemption rules; something with an actual letter must remain. */
function translatableText(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;
  if (!HAS_LETTER.test(trimmed.replace(HTML_ENTITY_REF, ' '))) return null;
  return trimmed;
}

/** Reads an "i18n-exempt: <reason>" marker out of a comment range's raw source text. Returns
 *  undefined both when there is no marker and when the marker's reason is missing or too short
 *  to be a real justification -- a bare or token reason must not silently exempt anything. */
function exemptReasonFromComment(commentText: string): string | undefined {
  const match = EXEMPT_MARKER.exec(commentText);
  if (!match) return undefined;
  const reason = match[1]?.trim();
  return reason && reason.length >= MIN_EXEMPT_REASON_LENGTH ? reason : undefined;
}

// D2: `typescript/unstable/ast`'s `getLeadingCommentRanges` does not return the block/line
// comments that sit in a node's leading trivia in this TS 7 build (verified empirically:
// it returns `undefined` for every position tried, including the exact comment start),
// while `getTrailingCommentRanges` does work. Rather than depend on that asymmetric,
// undocumented behavior, both directions are matched here with a plain regex over the raw
// source slice -- the trivia between two known offsets is always just "comments and
// whitespace", so a regex is sufficient and does not depend on internal scanner state.
// Escape hatch: if a future typescript release fixes `getLeadingCommentRanges`, this and
// `findExemptReasonInRange` can be deleted in favor of it.
const COMMENT_TEXT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

function findExemptReasonInRange(text: string, start: number, end: number): string | undefined {
  if (end <= start) return undefined;
  for (const match of text.slice(start, end).matchAll(COMMENT_TEXT)) {
    const reason = exemptReasonFromComment(match[0]);
    if (reason) return reason;
  }
  return undefined;
}

/** Inline exemption for JSX attribute string literals: a leading comment on the attribute,
 *  or a trailing same-line comment after the literal, e.g. `title="v0.1" // i18n-exempt: ...`. */
function attributeExemptReason(sourceFile: SourceFile, attr: JsxAttribute, literal: Node): string | undefined {
  const text = sourceFile.text;
  const leadingReason = findExemptReasonInRange(text, attr.getFullStart(), attr.getStart(sourceFile));
  if (leadingReason) return leadingReason;
  const lineBreak = text.indexOf('\n', literal.getEnd());
  return findExemptReasonInRange(text, literal.getEnd(), lineBreak === -1 ? text.length : lineBreak);
}

/** Inline exemption for a JSX child (text node or `{"literal"}` expression container): an
 *  adjacent `{/* i18n-exempt: ... *&#47;}` sibling, since neither has leading-trivia comments
 *  of its own (the comment is its own sibling node). */
function jsxChildExemptReason(sourceFile: SourceFile, child: JsxChild): string | undefined {
  const parent = child.parent;
  if (!isJsxElement(parent) && !isJsxFragment(parent)) return undefined;
  const children = parent.children;
  const idx = children.indexOf(child);
  if (idx < 0) return undefined;
  const neighbors: JsxChild[] = [];
  const before = children[idx - 1];
  const after = children[idx + 1];
  if (before !== undefined) neighbors.push(before);
  if (after !== undefined) neighbors.push(after);
  for (const neighbor of neighbors) {
    if (isJsxExpression(neighbor) && !neighbor.expression) {
      const reason = exemptReasonFromComment(neighbor.getText(sourceFile));
      if (reason) return reason;
    }
  }
  return undefined;
}

function toPosition(sourceFile: SourceFile, pos: number): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

interface ResolvedLiteral {
  text: string;
  node: Node;
}

/**
 * Recursively finds string/template literals that would render as-is through a chain of
 * "pick a branch, still render literal prose either way" wrappers: ternaries, `&&`/`||`/`??`
 * fallbacks, parentheses, array-literal elements (e.g. an array of strings rendered as JSX
 * children), and the static text spans of a template literal (which render around any `${...}`
 * holes regardless of what those holes contain, e.g. `` `Saved ${count} items` ``).
 *
 * Deliberately does NOT descend into calls, identifiers, or property access (`t(...)`,
 * `status`, `t.foo`) -- those are dynamic or already-translated values, not hardcoded prose,
 * and treating them as opaque stops the recursion exactly where issue #44's exemption for
 * "translation-call and API-provided expression children" expects it to stop.
 */
function resolveTranslatableLiterals(expr: Node | undefined): ResolvedLiteral[] {
  if (!expr) return [];
  if (isStringLiteral(expr) || isNoSubstitutionTemplateLiteral(expr)) {
    const text = translatableText(expr.text);
    return text ? [{ text, node: expr }] : [];
  }
  if (isParenthesizedExpression(expr)) {
    return resolveTranslatableLiterals(expr.expression);
  }
  if (isConditionalExpression(expr)) {
    return [...resolveTranslatableLiterals(expr.whenTrue), ...resolveTranslatableLiterals(expr.whenFalse)];
  }
  if (isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === SyntaxKind.AmpersandAmpersandToken
      || op === SyntaxKind.QuestionQuestionToken
      || op === SyntaxKind.BarBarToken
    ) {
      // The left side of `&&`/`||`/`??` is the condition/primary value, not rendered prose on
      // its own -- only the right side is a candidate literal.
      return resolveTranslatableLiterals(expr.right);
    }
    return [];
  }
  if (isArrayLiteralExpression(expr)) {
    return expr.elements.flatMap((element) => resolveTranslatableLiterals(element));
  }
  if (isTemplateExpression(expr)) {
    const staticText = [expr.head.text, ...expr.templateSpans.map((span) => span.literal.text)].join('');
    const text = translatableText(staticText);
    return text ? [{ text, node: expr }] : [];
  }
  return [];
}

/** Scans a source file's raw text for every `i18n-exempt` marker comment and reports the ones
 *  whose reason is missing or too short as violations in their own right (kind
 *  `invalid-exempt-marker`) -- a marker that looks reviewed but was not is worse than no marker,
 *  since `attributeExemptReason`/`jsxChildExemptReason` would otherwise just silently fail to
 *  exempt it and the marker's author would see no signal that anything is wrong. */
function collectInvalidExemptMarkers(sourceFile: SourceFile, relativeFile: string): HardcodedStringViolation[] {
  const violations: HardcodedStringViolation[] = [];
  for (const match of sourceFile.text.matchAll(COMMENT_TEXT)) {
    const commentText = match[0];
    if (!EXEMPT_MARKER.test(commentText)) continue;
    if (exemptReasonFromComment(commentText)) continue;
    const { line, column } = toPosition(sourceFile, match.index ?? 0);
    violations.push({ file: relativeFile, line, column, kind: 'invalid-exempt-marker', text: commentText.trim() });
  }
  return violations;
}

/** Walks one already-parsed source file's AST for hardcoded user-facing strings. */
function collectViolations(sourceFile: SourceFile, relativeFile: string): HardcodedStringViolation[] {
  const violations: HardcodedStringViolation[] = [...collectInvalidExemptMarkers(sourceFile, relativeFile)];

  function visit(node: Node): void {
    if (isJsxText(node)) {
      if (!node.containsOnlyTriviaWhiteSpaces) {
        const text = translatableText(node.getText(sourceFile));
        if (text && !jsxChildExemptReason(sourceFile, node)) {
          const { line, column } = toPosition(sourceFile, node.getStart(sourceFile));
          violations.push({ file: relativeFile, line, column, kind: 'jsx-text', text });
        }
      }
    } else if (isJsxExpression(node) && (isJsxElement(node.parent) || isJsxFragment(node.parent))) {
      // A literal string/template rendered directly as a child, e.g. `<div>{"Hello"}</div>`,
      // or reached through a conditional/logical/nullish/parenthesized/array-literal wrapper,
      // e.g. `<div>{ready ? "Saved" : "Saving"}</div>` -- the same hardcoded prose as JSX text,
      // just spelled with braces (and possibly branches). Dynamic expressions (identifiers,
      // property access, `{status}`, translation calls, ...) are left alone.
      const expr = node.expression;
      if (expr && (isStringLiteral(expr) || isNoSubstitutionTemplateLiteral(expr))) {
        const text = translatableText(expr.text);
        if (text && !jsxChildExemptReason(sourceFile, node)) {
          const { line, column } = toPosition(sourceFile, node.getStart(sourceFile));
          violations.push({ file: relativeFile, line, column, kind: 'jsx-text', text });
        }
      } else if (expr && !jsxChildExemptReason(sourceFile, node)) {
        for (const found of resolveTranslatableLiterals(expr)) {
          const { line, column } = toPosition(sourceFile, found.node.getStart(sourceFile));
          violations.push({ file: relativeFile, line, column, kind: 'jsx-text', text: found.text });
        }
      }
    } else if (isJsxAttribute(node)) {
      const attrName = node.name.getText(sourceFile);
      if (isUserFacingAttribute(attrName)) {
        const initializer = node.initializer;
        let literal: StringLiteral | NoSubstitutionTemplateLiteral | undefined;
        if (initializer && isStringLiteral(initializer)) {
          literal = initializer;
        } else if (
          initializer &&
          isJsxExpression(initializer) &&
          initializer.expression &&
          (isStringLiteral(initializer.expression) || isNoSubstitutionTemplateLiteral(initializer.expression))
        ) {
          literal = initializer.expression;
        }
        if (literal) {
          const text = translatableText(literal.text);
          if (text && !attributeExemptReason(sourceFile, node, literal)) {
            const { line, column } = toPosition(sourceFile, node.getStart(sourceFile));
            violations.push({ file: relativeFile, line, column, kind: 'jsx-attribute', attribute: attrName, text });
          }
        } else if (initializer && isJsxExpression(initializer) && initializer.expression) {
          const wrapperExpr = initializer.expression;
          if (!attributeExemptReason(sourceFile, node, wrapperExpr)) {
            for (const found of resolveTranslatableLiterals(wrapperExpr)) {
              const { line, column } = toPosition(sourceFile, found.node.getStart(sourceFile));
              violations.push({ file: relativeFile, line, column, kind: 'jsx-attribute', attribute: attrName, text: found.text });
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * Opens a batch of files through the TypeScript native API and hands back a lookup from
 * absolute path to its parsed `SourceFile`. One `API` instance (one native `tsgo` process)
 * is spawned per call and must be closed via the returned `close()` once scanning finishes.
 */
function openProject(absFiles: readonly string[], options: { cwd: string; fs?: FileSystem }): {
  getSourceFile: (absPath: string) => SourceFile | undefined;
  close: () => void;
} {
  const api = new API(options);
  const snapshot = absFiles.length > 0 ? api.updateSnapshot({ openFiles: [...absFiles] }) : undefined;
  return {
    getSourceFile(absPath) {
      const project = snapshot?.getDefaultProjectForFile(absPath);
      return project?.program.getSourceFile(absPath);
    },
    close() {
      api.close();
    },
  };
}

/** Lists every non-test .tsx file under `rootDir`, depth-first. Exported so callers (notably
 *  the CI gate's own integration test) can independently confirm that {@link scanDirectory}
 *  actually scanned every file it discovered, rather than trusting it not to have silently
 *  dropped one. */
export function listTsxFiles(rootDir: string, currentDir: string = rootDir, out: string[] = []): string[] {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      listTsxFiles(fullPath, fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push(fullPath);
    }
  }
  return out;
}

export interface DirectoryScanResult {
  violations: HardcodedStringViolation[];
  /** Number of discovered files the scan actually parsed and walked. Compare against
   *  `listTsxFiles(srcDir).length` to catch a regression where a file is silently skipped. */
  fileCount: number;
}

/** Scans every non-test .tsx file under `srcDir` (e.g. "<web>/src") through the real project.
 *  Fails closed: a file the native project can't produce a `SourceFile` for throws immediately
 *  with that file's path, rather than being silently skipped -- an unparsable file is a gate
 *  that quietly stopped checking, not an empty result. */
export function scanDirectory(srcDir: string): DirectoryScanResult {
  const webRoot = join(srcDir, '..');
  const absFiles = listTsxFiles(srcDir);
  if (absFiles.length === 0) return { violations: [], fileCount: 0 };
  const project = openProject(absFiles, { cwd: webRoot });
  try {
    const violations: HardcodedStringViolation[] = [];
    let fileCount = 0;
    for (const absPath of absFiles) {
      const sourceFile = project.getSourceFile(absPath);
      const relPath = relative(webRoot, absPath).split(sep).join('/');
      if (!sourceFile) {
        throw new Error(
          `hardcodedStringGuard: failed to parse "${relPath}" -- the i18n gate cannot verify `
            + 'this file for hardcoded strings and must fail closed instead of silently skipping it.',
        );
      }
      violations.push(...collectViolations(sourceFile, relPath));
      fileCount += 1;
    }
    return { violations, fileCount };
  } finally {
    project.close();
  }
}

export interface ScanFixture {
  /** Path reported on violations, e.g. "positive/Greeting.tsx". */
  file: string;
  text: string;
}

/**
 * Scans in-memory TSX fixtures (used by tests) without touching the real filesystem or the
 * real project's tsconfig -- files are served from a virtual filesystem into an inferred
 * TypeScript project, per `typescript/unstable/fs`'s `createVirtualFileSystem`. Fails closed
 * like {@link scanDirectory}: a fixture the project can't produce a `SourceFile` for throws
 * with that fixture's path instead of being silently skipped.
 */
export function scanFixtures(fixtures: readonly ScanFixture[]): HardcodedStringViolation[] {
  const root = '/hardcoded-string-guard-fixtures';
  const toAbsPath = (file: string) => `${root}/${file}`;
  const virtualFiles: Record<string, string> = {};
  for (const fixture of fixtures) {
    virtualFiles[toAbsPath(fixture.file)] = fixture.text;
  }
  const absFiles = fixtures.map((fixture) => toAbsPath(fixture.file));
  const project = openProject(absFiles, { cwd: root, fs: createVirtualFileSystem(virtualFiles) });
  try {
    const violations: HardcodedStringViolation[] = [];
    for (const fixture of fixtures) {
      const sourceFile = project.getSourceFile(toAbsPath(fixture.file));
      if (!sourceFile) {
        throw new Error(
          `hardcodedStringGuard: failed to parse fixture "${fixture.file}" -- failing closed `
            + 'instead of silently skipping it.',
        );
      }
      violations.push(...collectViolations(sourceFile, fixture.file));
    }
    return violations;
  } finally {
    project.close();
  }
}

/** Convenience single-fixture form of {@link scanFixtures}. */
export function scanSourceText(file: string, text: string): HardcodedStringViolation[] {
  return scanFixtures([{ file, text }]);
}

function baselineKey(entry: { file: string; line: number; text: string }): string {
  return `${entry.file}:${entry.line}:${entry.text}`;
}

/** Splits scan results into unexempted violations and ones matched by the reviewed baseline. */
export function partitionAgainstBaseline(
  violations: readonly HardcodedStringViolation[],
  baseline: readonly BaselineEntry[],
): { blocking: HardcodedStringViolation[]; baselined: HardcodedStringViolation[] } {
  const baselineKeys = new Set(baseline.map(baselineKey));
  const blocking: HardcodedStringViolation[] = [];
  const baselined: HardcodedStringViolation[] = [];
  for (const violation of violations) {
    if (baselineKeys.has(baselineKey(violation))) {
      baselined.push(violation);
    } else {
      blocking.push(violation);
    }
  }
  return { blocking, baselined };
}

export function formatViolation(v: HardcodedStringViolation): string {
  const where = v.kind === 'jsx-attribute' ? ` [${v.attribute}]`
    : v.kind === 'invalid-exempt-marker' ? ' [invalid i18n-exempt marker]'
    : '';
  return `${v.file}:${v.line}:${v.column}${where} -> "${v.text}"`;
}
