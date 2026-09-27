import { readFileSync, readdirSync, statSync } from 'node:fs';
import { matchesGlob, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..');
const packages = [
  { name: 'domain-api', root: 'packages/domain-api' },
  { name: 'policy-compiler', root: 'packages/policy-compiler' },
  { name: 'web', root: 'packages/web' },
];

function testFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return testFiles(path);
    return /\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

const defaultExcludes = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,jest,vitest}.config.*',
];

function configuredPatterns(source: string, key: 'include' | 'exclude', configPath: string): string[] | undefined {
  const match = source.match(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!match) {
    if (new RegExp(`\\b${key}\\s*:`).test(source)) {
      throw new Error(`Unable to parse literal ${key} array in ${configPath}`);
    }
    return undefined;
  }

  const body = match[1]!.trim();
  if (!body) return [];
  const entries = body.split(',');
  const hasTrailingComma = entries.at(-1)?.trim() === '';
  if (hasTrailingComma) entries.pop();
  const patterns = entries.map((entry) => entry.trim().match(/^(['"])(.*?)\1$/));
  if (patterns.length === 0 || patterns.some((entry) => !entry)) {
    throw new Error(`Unable to parse literal ${key} array in ${configPath}`);
  }
  return patterns.map((entry) => {
    const pattern = entry![2];
    if (pattern === undefined) throw new Error(`Unable to parse literal ${key} array in ${configPath}`);
    return pattern;
  });
}

function configuredPatternsFor(configPath: string, key: 'include' | 'exclude'): string[] {
  const source = readFileSync(configPath, 'utf8');
  const patterns = configuredPatterns(source, key, configPath);
  if (patterns) return patterns;
  if (key === 'include') return ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
  return defaultExcludes;
}

describe('workspace Vitest includes', () => {
  it('matches every TypeScript test under each package src or tests directory', () => {
    const unmatched = packages.flatMap(({ name, root }) => {
      const packageRoot = resolve(repositoryRoot, root);
      const configPath = resolve(packageRoot, 'vitest.config.ts');
      const includes = configuredPatternsFor(configPath, 'include');
      const excludes = configuredPatternsFor(configPath, 'exclude');
      const files = ['src', 'tests']
        .map((directory) => resolve(packageRoot, directory))
        .filter((directory) => statSync(directory, { throwIfNoEntry: false })?.isDirectory())
        .flatMap(testFiles);

      return files
        .map((file) => relative(packageRoot, file).split(sep).join('/'))
        .filter((file) =>
          !includes.some((pattern) => matchesGlob(file, pattern)) ||
          excludes.some((pattern) => matchesGlob(file, pattern)),
        )
        .map((file) => `${name}/${file}`);
    });

    expect(unmatched).toEqual([]);
  });
});
