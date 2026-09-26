import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxText,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
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
  kind: 'jsx-text' | 'jsx-attribute';
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

/** Returns the trimmed text if it looks like translatable prose, otherwise null. Numbers,
 *  punctuation, symbols, and HTML entity refs alone (e.g. "42%", "3.14", "&bull;") are not
 *  prose per issue #44's exemption rules; something with an actual letter must remain. */
function translatableText(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;
  if (!HAS_LETTER.test(trimmed.replace(HTML_ENTITY_REF, ' '))) return null;
  return trimmed;
}

/** Reads an "i18n-exempt: <reason>" marker out of a comment range's raw source text. */
function exemptReasonFromComment(commentText: string): string | undefined {
  const match = EXEMPT_MARKER.exec(commentText);
  if (!match) return undefined;
  const reason = match[1]?.trim();
  return reason ? reason : 'exempted inline (no reason given)';
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

/** Walks one already-parsed source file's AST for hardcoded user-facing strings. */
function collectViolations(sourceFile: SourceFile, relativeFile: string): HardcodedStringViolation[] {
  const violations: HardcodedStringViolation[] = [];

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
      // A literal string/template rendered directly as a child, e.g. `<div>{"Hello"}</div>` --
      // the same hardcoded prose as JSX text, just spelled with braces. Dynamic expressions
      // (identifiers, property access, `{status}`, translation calls, ...) are left alone.
      const expr = node.expression;
      if (expr && (isStringLiteral(expr) || isNoSubstitutionTemplateLiteral(expr))) {
        const text = translatableText(expr.text);
        if (text && !jsxChildExemptReason(sourceFile, node)) {
          const { line, column } = toPosition(sourceFile, node.getStart(sourceFile));
          violations.push({ file: relativeFile, line, column, kind: 'jsx-text', text });
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

function listTsxFiles(rootDir: string, currentDir: string = rootDir, out: string[] = []): string[] {
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

/** Scans every non-test .tsx file under `srcDir` (e.g. "<web>/src") through the real project. */
export function scanDirectory(srcDir: string): HardcodedStringViolation[] {
  const webRoot = join(srcDir, '..');
  const absFiles = listTsxFiles(srcDir);
  if (absFiles.length === 0) return [];
  const project = openProject(absFiles, { cwd: webRoot });
  try {
    const violations: HardcodedStringViolation[] = [];
    for (const absPath of absFiles) {
      const sourceFile = project.getSourceFile(absPath);
      if (!sourceFile) continue;
      const relPath = relative(webRoot, absPath).split(sep).join('/');
      violations.push(...collectViolations(sourceFile, relPath));
    }
    return violations;
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
 * TypeScript project, per `typescript/unstable/fs`'s `createVirtualFileSystem`.
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
      if (!sourceFile) continue;
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
  const where = v.kind === 'jsx-attribute' ? ` [${v.attribute}]` : '';
  return `${v.file}:${v.line}:${v.column}${where} -> "${v.text}"`;
}
