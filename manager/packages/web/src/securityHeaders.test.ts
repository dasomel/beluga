import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(import.meta.dirname, '..');
const indexHtml = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
const nginxConf = readFileSync(resolve(webRoot, 'nginx.conf'), 'utf8');

describe('nginx security headers (D-MLOGIN-4)', () => {
  it('allows exactly the inline bootstrap script in index.html by hash', () => {
    const inline = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(inline).toHaveLength(1);
    const hash = createHash('sha256').update(inline[0]?.[1] ?? '').digest('base64');
    const csp = nginxConf.match(/add_header Content-Security-Policy "([^"]*)"/)?.[1] ?? '';
    const scriptSrc = csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).toContain(`'sha256-${hash}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('takes the connect-src origins from the deployment environment', () => {
    expect(nginxConf).toContain('connect-src ${CSP_CONNECT_SRC};');
  });

  it('keeps the OIDC callback URL out of Referer and falls back to index.html', () => {
    expect(nginxConf).toContain('add_header Referrer-Policy "no-referrer" always;');
    expect(nginxConf).toContain('try_files $uri /index.html;');
  });

  it('does not override inherited add_header in a location block', () => {
    const locationBody = nginxConf.slice(nginxConf.indexOf('location / {'));
    expect(locationBody).not.toContain('add_header');
  });
});

describe('CSP_CONNECT_SRC entrypoint validation', () => {
  const script = resolve(webRoot, 'docker/15-validate-csp-connect-src.sh');
  const run = (value: string | undefined) =>
    spawnSync('sh', [script], { env: value === undefined ? {} : { CSP_CONNECT_SRC: value }, encoding: 'utf8' });

  it.each([
    "'self'",
    "'self' https://sso.local.beluga.internal",
    "'self' https://sso.example:8443 http://localhost:8787 https://*.example.com",
  ])('accepts %s', (value) => {
    expect(run(value).status).toBe(0);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['a directive injection', "'self'; script-src *"],
    ['a double quote', `'self' "https://a.example`],
    ['a newline', "'self'\nhttps://a.example"],
    ['a bare wildcard', '*'],
    ['unsafe-inline', "'unsafe-inline'"],
    ['a path', 'https://a.example/x'],
    ['a trailing space', "'self' "],
    ['a non-http scheme', 'data:'],
  ])('rejects %s', (_name, value) => {
    const result = run(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CSP_CONNECT_SRC rejected');
  });
});
