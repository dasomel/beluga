#!/usr/bin/env node
/**
 * Run npm audit against production dependencies and enforce vulnerability policy.
 * Fails on any unsuppressed high or critical severity finding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const EXCEPTIONS_FILE = path.join(REPO_ROOT, 'policies', 'vulnerability-exceptions.json');

/**
 * Load and validate vulnerability-exceptions.json.
 */
export function loadExceptions(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read vulnerability exceptions file at ${filePath}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cannot parse vulnerability exceptions at ${filePath} as JSON: ${err.message}`);
  }

  if (!Array.isArray(data)) {
    throw new Error('vulnerability exceptions file must contain a JSON array');
  }

  for (const [idx, entry] of data.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`exception entry at index ${idx} must be an object`);
    }
    const { advisoryId, package: pkg, reason, reviewedBy, expiresAt } = entry;
    if (!advisoryId || typeof advisoryId !== 'string' || !advisoryId.trim()) {
      throw new Error(`exception at index ${idx} missing non-empty 'advisoryId'`);
    }
    if (!pkg || typeof pkg !== 'string' || !pkg.trim()) {
      throw new Error(`exception at index ${idx} missing non-empty 'package'`);
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`exception at index ${idx} missing non-empty 'reason'`);
    }
    if (!reviewedBy || typeof reviewedBy !== 'string' || !reviewedBy.trim()) {
      throw new Error(`exception at index ${idx} missing non-empty 'reviewedBy'`);
    }
    if (!expiresAt || typeof expiresAt !== 'string' || isNaN(new Date(expiresAt).getTime())) {
      throw new Error(
        `exception at index ${idx} for ${pkg} missing valid 'expiresAt' date string (e.g. YYYY-MM-DD)`
      );
    }
  }

  return data;
}

/**
 * Extract advisory identifiers from an npm audit vulnerability via item.
 */
export function extractAdvisoryIds(viaItem) {
  const ids = [];
  if (!viaItem || typeof viaItem !== 'object') {
    return ids;
  }
  if (typeof viaItem.url === 'string') {
    const match = viaItem.url.match(/GHSA-[a-z0-9-]+/i);
    if (match) {
      ids.push(match[0]);
    }
  }
  if (viaItem.source !== undefined && viaItem.source !== null) {
    ids.push(String(viaItem.source));
  }
  if (typeof viaItem.id === 'string' || typeof viaItem.id === 'number') {
    ids.push(String(viaItem.id));
  }
  return ids;
}

/**
 * Evaluate npm audit report against exceptions.
 */
export function evaluateAudit(report, exceptions = [], now = new Date()) {
  const meta = report.metadata || {};
  const vulnCounts = meta.vulnerabilities || {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0,
  };
  const prodDepsCount = meta.dependencies?.prod ?? 'unknown';

  const unsuppressedFindings = [];
  const suppressedFindings = [];
  const expiredExceptions = [];
  const matchedExceptionIndices = new Set();

  // Check if any exceptions in the policy are already expired
  for (const [idx, exception] of exceptions.entries()) {
    const expDate = new Date(exception.expiresAt);
    if (expDate.getTime() <= now.getTime()) {
      expiredExceptions.push({
        exception,
        reason: `Policy exception for ${exception.package} (${exception.advisoryId}) EXPIRED on ${exception.expiresAt}`,
      });
    }
  }

  const vulnerabilities = report.vulnerabilities || {};

  for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
    const severity = (vuln.severity || '').toLowerCase();
    const isFailingSeverity = severity === 'high' || severity === 'critical';

    // Collect advisories from 'via'
    const vias = Array.isArray(vuln.via) ? vuln.via : [];
    const advisoryObjects = vias.filter((v) => typeof v === 'object' && v !== null);

    const findingsForPkg = [];
    if (advisoryObjects.length > 0) {
      for (const adv of advisoryObjects) {
        const advIds = extractAdvisoryIds(adv);
        findingsForPkg.push({
          package: pkgName,
          severity: (adv.severity || severity).toLowerCase(),
          title: adv.title || vuln.name || pkgName,
          url: adv.url || '',
          advisoryIds: advIds,
          range: adv.range || vuln.range || '',
        });
      }
    } else {
      findingsForPkg.push({
        package: pkgName,
        severity,
        title: `Vulnerable dependency in chain (${vias.join(', ')})`,
        url: '',
        advisoryIds: [],
        range: vuln.range || '',
      });
    }

    for (const finding of findingsForPkg) {
      const isHighOrCritical = finding.severity === 'high' || finding.severity === 'critical';
      if (!isHighOrCritical) {
        continue;
      }

      // Find matching exception
      let matchedIdx = -1;
      for (let i = 0; i < exceptions.length; i++) {
        const exc = exceptions[i];
        if (exc.package === finding.package) {
          // A finding with no parseable advisory id (npm audit reported it as a
          // via-chain reference only, e.g. `via: ['some-other-dep']`) must NOT
          // match an exception written for a different, specific advisory on the
          // same package - that would silently suppress an unrelated future
          // vulnerability on the same package. `advisoryId: '*'` is the only way
          // to intentionally suppress every high/critical finding on a package,
          // and it must be written explicitly and reviewed as such.
          const isWildcardException = exc.advisoryId === '*';
          const isExactMatch = finding.advisoryIds.some(
            (id) => id.toLowerCase() === exc.advisoryId.toLowerCase()
          );
          if (isWildcardException || isExactMatch) {
            matchedIdx = i;
            break;
          }
        }
      }

      if (matchedIdx >= 0) {
        const exc = exceptions[matchedIdx];
        matchedExceptionIndices.add(matchedIdx);
        const expDate = new Date(exc.expiresAt);
        if (expDate.getTime() <= now.getTime()) {
          unsuppressedFindings.push({
            ...finding,
            failureReason: `Exception EXPIRED on ${exc.expiresAt}`,
          });
        } else {
          suppressedFindings.push({
            ...finding,
            exception: exc,
          });
        }
      } else {
        unsuppressedFindings.push(finding);
      }
    }
  }

  const ok = unsuppressedFindings.length === 0 && expiredExceptions.length === 0;

  return {
    ok,
    prodDepsCount,
    vulnCounts,
    unsuppressedFindings,
    suppressedFindings,
    expiredExceptions,
  };
}

/**
 * Self-test with synthetic test cases.
 */
export function selfTest() {
  const now = new Date('2026-06-01T00:00:00Z');

  // Case 1: Clean report
  const cleanReport = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      dependencies: { prod: 40 },
    },
  };
  const r1 = evaluateAudit(cleanReport, [], now);
  if (!r1.ok || r1.unsuppressedFindings.length !== 0) {
    throw new Error('self-test failed: clean report should pass');
  }

  // Case 2: Moderate vulnerability only (should pass, only high/critical fail)
  const moderateReport = {
    auditReportVersion: 2,
    vulnerabilities: {
      'mod-pkg': {
        name: 'mod-pkg',
        severity: 'moderate',
        via: [{ source: 101, title: 'Mod issue', severity: 'moderate' }],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
      dependencies: { prod: 40 },
    },
  };
  const r2 = evaluateAudit(moderateReport, [], now);
  if (!r2.ok || r2.unsuppressedFindings.length !== 0) {
    throw new Error('self-test failed: moderate vulnerability should not fail');
  }

  // Case 3: High vulnerability without exception (must fail)
  const highReport = {
    auditReportVersion: 2,
    vulnerabilities: {
      'bad-pkg': {
        name: 'bad-pkg',
        severity: 'high',
        via: [
          {
            source: 999,
            title: 'Critical RCE',
            url: 'https://github.com/advisories/GHSA-1234-5678-90ab',
            severity: 'high',
          },
        ],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
      dependencies: { prod: 40 },
    },
  };
  const r3 = evaluateAudit(highReport, [], now);
  if (r3.ok || r3.unsuppressedFindings.length !== 1) {
    throw new Error('self-test failed: high vulnerability without exception must fail');
  }

  // Case 4: High vulnerability with active exception (must pass)
  const activeExceptions = [
    {
      advisoryId: 'GHSA-1234-5678-90ab',
      package: 'bad-pkg',
      reason: 'Sandbox isolated, not exploitable',
      reviewedBy: 'sec-lead',
      expiresAt: '2026-12-31',
    },
  ];
  const r4 = evaluateAudit(highReport, activeExceptions, now);
  if (!r4.ok || r4.suppressedFindings.length !== 1 || r4.unsuppressedFindings.length !== 0) {
    throw new Error('self-test failed: active reviewed exception must pass');
  }

  // Case 5: High vulnerability with expired exception (must fail)
  const expiredExceptions = [
    {
      advisoryId: 'GHSA-1234-5678-90ab',
      package: 'bad-pkg',
      reason: 'Temporary waiver',
      reviewedBy: 'sec-lead',
      expiresAt: '2026-01-01',
    },
  ];
  const r5 = evaluateAudit(highReport, expiredExceptions, now);
  if (r5.ok || r5.unsuppressedFindings.length === 0 || r5.expiredExceptions.length === 0) {
    throw new Error('self-test failed: expired exception must fail');
  }

  // Case 6: high finding with no parseable advisory id (npm audit reported it
  // as a via-chain reference only) must NOT be suppressed by an exception
  // written for a different, specific advisory on the same package.
  const chainOnlyReport = {
    auditReportVersion: 2,
    vulnerabilities: {
      'chain-pkg': { name: 'chain-pkg', severity: 'high', via: ['some-other-dep'] },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
      dependencies: { prod: 40 },
    },
  };
  const unrelatedExceptions = [
    {
      advisoryId: 'GHSA-unrelated-0000',
      package: 'chain-pkg',
      reason: 'Old waiver for a different advisory',
      reviewedBy: 'sec-lead',
      expiresAt: '2027-01-01',
    },
  ];
  const r6 = evaluateAudit(chainOnlyReport, unrelatedExceptions, now);
  if (r6.ok || r6.unsuppressedFindings.length !== 1) {
    throw new Error(
      'self-test failed: a chain-only finding with no advisory id must not be silently ' +
        "suppressed by an unrelated exception for the same package (empty advisoryIds must " +
        "never wildcard-match)"
    );
  }

  // Case 7: an explicit `advisoryId: '*'` exception is the only way to
  // intentionally suppress every high/critical finding on a package.
  const explicitWildcardExceptions = [
    {
      advisoryId: '*',
      package: 'chain-pkg',
      reason: 'All findings on this internal fork reviewed and accepted',
      reviewedBy: 'sec-lead',
      expiresAt: '2027-01-01',
    },
  ];
  const r7 = evaluateAudit(chainOnlyReport, explicitWildcardExceptions, now);
  if (!r7.ok || r7.suppressedFindings.length !== 1) {
    throw new Error("self-test failed: an explicit '*' exception must suppress a chain-only finding");
  }
}

/**
 * Main execution.
 */
export function main() {
  try {
    selfTest();
  } catch (err) {
    console.error(`check-dependency-vulnerabilities self-test FAIL: ${err.message}`);
    process.exit(1);
  }

  let exceptions = [];
  try {
    exceptions = loadExceptions(EXCEPTIONS_FILE);
  } catch (err) {
    console.error(`vulnerability exceptions configuration FAIL: ${err.message}`);
    process.exit(1);
  }

  console.log('Running npm audit for production dependencies (--omit=dev)...');
  const auditResult = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (auditResult.error) {
    console.error(`ERROR: Failed to run npm audit: ${auditResult.error.message}`);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(auditResult.stdout);
  } catch (err) {
    console.error('ERROR: npm audit output is not valid JSON. Network or registry error?');
    if (auditResult.stderr) {
      console.error(auditResult.stderr);
    }
    if (auditResult.stdout) {
      console.error(auditResult.stdout.slice(0, 500));
    }
    process.exit(1);
  }

  const evaluation = evaluateAudit(report, exceptions, new Date());

  console.log('\n=== Production Dependency Vulnerability Scan ===\n');
  console.log(`Scanned ${evaluation.prodDepsCount} production dependencies.`);
  console.log(
    `Vulnerabilities: critical=${evaluation.vulnCounts.critical || 0}, high=${
      evaluation.vulnCounts.high || 0
    }, moderate=${evaluation.vulnCounts.moderate || 0}, low=${evaluation.vulnCounts.low || 0}, info=${
      evaluation.vulnCounts.info || 0
    }`
  );

  if (evaluation.expiredExceptions.length > 0) {
    console.error('\n[EXPIRED EXCEPTIONS]');
    for (const exp of evaluation.expiredExceptions) {
      console.error(`- ${exp.reason}`);
    }
  }

  if (evaluation.suppressedFindings.length > 0) {
    console.log('\n[SUPPRESSED FINDINGS]');
    for (const sup of evaluation.suppressedFindings) {
      const advStr = sup.advisoryIds.join(', ') || 'N/A';
      console.log(
        `- [${sup.severity.toUpperCase()}] ${sup.package} (${advStr}): ${sup.title}`
      );
      console.log(
        `  Suppressed by ${sup.exception.reviewedBy} until ${sup.exception.expiresAt}: ${sup.exception.reason}`
      );
    }
  }

  if (evaluation.unsuppressedFindings.length > 0) {
    console.error('\n[FAILING FINDINGS - HIGH/CRITICAL]');
    for (const f of evaluation.unsuppressedFindings) {
      const advStr = f.advisoryIds.join(', ') || 'N/A';
      console.error(`- [${f.severity.toUpperCase()}] ${f.package} (${advStr}): ${f.title}`);
      if (f.url) console.error(`  URL: ${f.url}`);
      if (f.failureReason) console.error(`  Reason: ${f.failureReason}`);
    }
  }

  console.log();
  if (!evaluation.ok) {
    console.error(
      'Vulnerability check FAILED: Unsuppressed high/critical vulnerabilities or expired exceptions found.'
    );
    console.error('To suppress reviewed findings, configure policies/vulnerability-exceptions.json');
    process.exit(1);
  }

  console.log('Dependency vulnerability check: PASS (0 unsuppressed high/critical vulnerabilities)');
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
