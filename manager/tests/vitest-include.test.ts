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

function configuredIncludes(configPath: string): string[] {
  const source = readFileSync(configPath, 'utf8');
  const match = source.match(/include\s*:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(([, pattern]) => pattern);
}

describe('workspace Vitest includes', () => {
  it('matches every TypeScript test under each package src or tests directory', () => {
    const unmatched = packages.flatMap(({ name, root }) => {
      const packageRoot = resolve(repositoryRoot, root);
      const includes = configuredIncludes(resolve(packageRoot, 'vitest.config.ts'));
      const files = ['src', 'tests']
        .map((directory) => resolve(packageRoot, directory))
        .filter((directory) => statSync(directory, { throwIfNoEntry: false })?.isDirectory())
        .flatMap(testFiles);

      return files
        .map((file) => relative(packageRoot, file).split(sep).join('/'))
        .filter((file) => !includes.some((pattern) => matchesGlob(file, pattern)))
        .map((file) => `${name}/${file}`);
    });

    expect(unmatched).toEqual([]);
  });
});
