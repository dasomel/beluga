import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packagesRoot = join(workspaceRoot, 'packages');
const allowedHttpHosts: Record<string, string> = {};
const localHttpEndpointPattern = /http:\/\/[^\n;]{0,160}?\.local\.beluga\.internal(?=[/"'`\s?&#]|$)/gi;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('local service endpoint schemes', () => {
  it('matches literal, template, and concatenated HTTP endpoints but ignores HTTPS', () => {
    const fixtures = [
      'http://trino.local.beluga.internal',
      'http://${svc}.local.beluga.internal',
      '"http://" + svc + ".local.beluga.internal"',
    ];

    for (const fixture of fixtures) {
      expect([...fixture.matchAll(localHttpEndpointPattern)]).toHaveLength(1);
      localHttpEndpointPattern.lastIndex = 0;
    }
    expect([...`https://trino.local.beluga.internal`.matchAll(localHttpEndpointPattern)]).toHaveLength(0);
  });

  it('uses HTTPS for every routed local Beluga hostname in package sources', () => {
    const sourceDirectories = readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(packagesRoot, entry.name, 'src'))
      .filter(existsSync);
    const violations = sourceDirectories.flatMap((directory) => sourceFiles(directory)).flatMap((file) => {
      const content = readFileSync(file, 'utf8');
      return [...content.matchAll(localHttpEndpointPattern)]
        .filter((match) => !allowedHttpHosts[match[0].toLowerCase()])
        .map((match) => `${file}: ${match[0]}`);
    });

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
