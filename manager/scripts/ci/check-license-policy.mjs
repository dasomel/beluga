#!/usr/bin/env node
/**
 * Validate installed production dependency licenses against policies/license-policy.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const POLICY_FILE = path.join(REPO_ROOT, 'policies', 'license-policy.json');
const LOCK_FILE = path.join(REPO_ROOT, 'package-lock.json');
const NODE_MODULES_DIR = path.join(REPO_ROOT, 'node_modules');

/**
 * Load and validate license-policy.json.
 */
export function loadPolicy(policyPath) {
  let raw;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read license policy ${policyPath}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cannot parse license policy ${policyPath} as JSON: ${err.message}`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('policy must be a JSON object');
  }

  const { approvedLicenses, exceptions = [] } = data;
  if (!Array.isArray(approvedLicenses) || approvedLicenses.length === 0) {
    throw new Error('approvedLicenses must be a non-empty array of strings');
  }

  const approvedSet = new Set();
  for (const lic of approvedLicenses) {
    if (typeof lic !== 'string' || !lic.trim()) {
      throw new Error('each approved license must be a non-empty string');
    }
    if (approvedSet.has(lic)) {
      throw new Error(`duplicate approved license: ${lic}`);
    }
    approvedSet.add(lic);
  }

  if (!Array.isArray(exceptions)) {
    throw new Error('exceptions must be an array');
  }

  for (const entry of exceptions) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('each exception must be an object');
    }
    const { package: pkg, reason, reviewedBy, expiresAt } = entry;
    if (!pkg || typeof pkg !== 'string' || !pkg.trim()) {
      throw new Error('exception entry requires non-empty package string');
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`exception for ${pkg} requires non-empty reason string`);
    }
    if (!reviewedBy || typeof reviewedBy !== 'string' || !reviewedBy.trim()) {
      throw new Error(`exception for ${pkg} requires non-empty reviewedBy string`);
    }
    if (!expiresAt || typeof expiresAt !== 'string' || isNaN(new Date(expiresAt).getTime())) {
      throw new Error(`exception for ${pkg} requires valid expiresAt date string (e.g. YYYY-MM-DD)`);
    }
  }

  return { approvedLicenses: approvedSet, exceptions };
}

/**
 * Extract declared licenses from package.json contents (handles string, object, array).
 */
export function extractDeclaredLicenses(pkgJson) {
  const licenses = [];

  if (typeof pkgJson.license === 'string' && pkgJson.license.trim()) {
    licenses.push(pkgJson.license.trim());
  } else if (pkgJson.license && typeof pkgJson.license === 'object' && typeof pkgJson.license.type === 'string') {
    if (pkgJson.license.type.trim()) {
      licenses.push(pkgJson.license.type.trim());
    }
  } else if (Array.isArray(pkgJson.licenses)) {
    for (const item of pkgJson.licenses) {
      if (typeof item === 'string' && item.trim()) {
        licenses.push(item.trim());
      } else if (item && typeof item === 'object' && typeof item.type === 'string' && item.type.trim()) {
        licenses.push(item.type.trim());
      }
    }
  }

  return licenses;
}

/**
 * Check if a license identifier or SPDX expression is approved.
 */
export function isLicenseApproved(licenseStr, approvedSet) {
  if (approvedSet.has(licenseStr)) {
    return true;
  }

  const clean = licenseStr.replace(/^\(|\)$/g, '').trim();

  // Dual/Multi-license OR: user may choose any, so valid if at least one is approved
  if (clean.includes(' OR ')) {
    const parts = clean.split(' OR ').map((part) => part.trim().replace(/^\(|\)$/g, ''));
    return parts.some((part) => approvedSet.has(part));
  }

  // Combined AND: all parts must be approved
  if (clean.includes(' AND ')) {
    const parts = clean.split(' AND ').map((part) => part.trim().replace(/^\(|\)$/g, ''));
    return parts.every((part) => approvedSet.has(part));
  }

  return false;
}

/**
 * Read package-lock.json and find all production dependencies (excluding workspace packages).
 */
export function getProductionDependencies(lockfilePath) {
  let raw;
  try {
    raw = fs.readFileSync(lockfilePath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read package-lock.json at ${lockfilePath}: ${err.message}`);
  }

  const lock = JSON.parse(raw);
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json missing packages mapping');
  }

  const prodPkgs = new Set();
  for (const [key, pkgData] of Object.entries(lock.packages)) {
    if (!key.startsWith('node_modules/')) {
      continue;
    }
    // Skip if marked dev-only
    if (pkgData.dev) {
      continue;
    }
    const pkgName = key.replace(/^node_modules\//, '');
    // Skip internal workspace packages
    if (pkgName.startsWith('@beluga-manager/') || pkgData.link) {
      continue;
    }
    prodPkgs.add(pkgName);
  }

  return prodPkgs;
}

/**
 * Walk node_modules to find package.json files for top-level and scoped packages.
 */
export function walkInstalledPackages(nodeModulesDir) {
  const installed = new Map();
  if (!fs.existsSync(nodeModulesDir)) {
    return installed;
  }

  const topEntries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  for (const entry of topEntries) {
    if (entry.name.startsWith('.')) continue;

    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      const subEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.name.startsWith('.')) continue;
        const pkgName = `${entry.name}/${sub.name}`;
        const pkgJsonPath = path.join(scopeDir, sub.name, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          installed.set(pkgName, pkgJsonPath);
        }
      }
    } else if (entry.isDirectory()) {
      const pkgName = entry.name;
      const pkgJsonPath = path.join(nodeModulesDir, entry.name, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        installed.set(pkgName, pkgJsonPath);
      }
    }
  }

  return installed;
}

/**
 * Check production dependencies against approved licenses and exceptions.
 */
export function checkLicenses(prodPkgs, installedMap, approvedSet, exceptions = [], now = new Date()) {
  const diagnostics = [];
  const inventory = [];

  const sortedPkgs = Array.from(prodPkgs).sort();

  for (const pkgName of sortedPkgs) {
    const pkgJsonPath = installedMap.get(pkgName);
    if (!pkgJsonPath) {
      diagnostics.push(`[${pkgName}] FAIL: package not found in node_modules`);
      inventory.push({
        package: pkgName,
        version: 'unknown',
        licenses: [],
        policyStatus: 'missing_package',
      });
      continue;
    }

    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      diagnostics.push(`[${pkgName}] FAIL: invalid package.json: ${err.message}`);
      inventory.push({
        package: pkgName,
        version: 'unknown',
        licenses: [],
        policyStatus: 'invalid_package_json',
      });
      continue;
    }

    const version = pkgJson.version || 'unknown';
    const declaredLicenses = extractDeclaredLicenses(pkgJson);

    if (declaredLicenses.length === 0) {
      diagnostics.push(`[${pkgName}@${version}] FAIL: missing or unparseable license`);
      inventory.push({
        package: pkgName,
        version,
        licenses: [],
        policyStatus: 'missing_license',
      });
      continue;
    }

    // Check if declared licenses are approved
    const unapproved = declaredLicenses.filter((lic) => !isLicenseApproved(lic, approvedSet));

    if (unapproved.length === 0) {
      diagnostics.push(`[${pkgName}@${version}] OK (${declaredLicenses.join(', ')})`);
      inventory.push({
        package: pkgName,
        version,
        licenses: declaredLicenses,
        policyStatus: 'approved',
      });
      continue;
    }

    // Check for reviewed exception
    const exception = exceptions.find((e) => e.package === pkgName);
    if (exception) {
      const expDate = new Date(exception.expiresAt);
      if (expDate.getTime() <= now.getTime()) {
        diagnostics.push(
          `[${pkgName}@${version}] FAIL: unapproved license ${JSON.stringify(unapproved)} - exception EXPIRED on ${exception.expiresAt}`
        );
        inventory.push({
          package: pkgName,
          version,
          licenses: declaredLicenses,
          policyStatus: 'expired_exception',
        });
      } else {
        diagnostics.push(
          `[${pkgName}@${version}] OK (reviewed exception by ${exception.reviewedBy}, expires ${exception.expiresAt}: ${exception.reason})`
        );
        inventory.push({
          package: pkgName,
          version,
          licenses: declaredLicenses,
          policyStatus: 'approved_exception',
        });
      }
    } else {
      diagnostics.push(
        `[${pkgName}@${version}] FAIL: unapproved license ${JSON.stringify(unapproved)}`
      );
      inventory.push({
        package: pkgName,
        version,
        licenses: declaredLicenses,
        policyStatus: 'unapproved',
      });
    }
  }

  return { diagnostics, inventory };
}

/**
 * Self-test with synthetic fixtures on every run.
 */
export function selfTest(approvedSet) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beluga-manager-license-self-test-'));

  try {
    const fixtureNm = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(path.join(fixtureNm, 'ok-pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureNm, 'ok-pkg', 'package.json'),
      JSON.stringify({ name: 'ok-pkg', version: '1.0.0', license: 'MIT' })
    );

    fs.mkdirSync(path.join(fixtureNm, 'bad-pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureNm, 'bad-pkg', 'package.json'),
      JSON.stringify({ name: 'bad-pkg', version: '1.0.0', license: 'GPL-3.0' })
    );

    fs.mkdirSync(path.join(fixtureNm, 'nolic-pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureNm, 'nolic-pkg', 'package.json'),
      JSON.stringify({ name: 'nolic-pkg', version: '1.0.0' })
    );

    fs.mkdirSync(path.join(fixtureNm, 'except-pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureNm, 'except-pkg', 'package.json'),
      JSON.stringify({ name: 'except-pkg', version: '1.0.0', license: 'GPL-3.0' })
    );

    fs.mkdirSync(path.join(fixtureNm, 'expired-pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureNm, 'expired-pkg', 'package.json'),
      JSON.stringify({ name: 'expired-pkg', version: '1.0.0', license: 'GPL-3.0' })
    );

    const installed = walkInstalledPackages(fixtureNm);
    const prodPkgs = new Set(['ok-pkg', 'bad-pkg', 'nolic-pkg', 'except-pkg', 'expired-pkg']);

    const now = new Date('2026-06-01T00:00:00Z');
    const exceptions = [
      {
        package: 'except-pkg',
        reason: 'Temporary approval',
        reviewedBy: 'security-team',
        expiresAt: '2026-12-31',
      },
      {
        package: 'expired-pkg',
        reason: 'Old approval',
        reviewedBy: 'security-team',
        expiresAt: '2026-01-01',
      },
    ];

    const { diagnostics } = checkLicenses(prodPkgs, installed, approvedSet, exceptions, now);

    const okLine = diagnostics.find((d) => d.includes('[ok-pkg@1.0.0] OK'));
    if (!okLine) throw new Error('self-test failed: ok-pkg was not accepted');

    const badLine = diagnostics.find((d) => d.includes('[bad-pkg@1.0.0] FAIL: unapproved license'));
    if (!badLine) throw new Error('self-test failed: bad-pkg was not rejected');

    const noLicLine = diagnostics.find((d) => d.includes('[nolic-pkg@1.0.0] FAIL: missing or unparseable'));
    if (!noLicLine) throw new Error('self-test failed: nolic-pkg was not rejected');

    const exceptLine = diagnostics.find((d) => d.includes('[except-pkg@1.0.0] OK (reviewed exception'));
    if (!exceptLine) throw new Error('self-test failed: except-pkg was not accepted via exception');

    const expiredLine = diagnostics.find((d) => d.includes('[expired-pkg@1.0.0] FAIL: unapproved license') && d.includes('EXPIRED'));
    if (!expiredLine) throw new Error('self-test failed: expired-pkg was not rejected');

    // Also verify SPDX expression handling
    if (!isLicenseApproved('(MIT OR GPL-3.0)', approvedSet)) {
      throw new Error('self-test failed: (MIT OR GPL-3.0) should be approved under OR');
    }
    if (isLicenseApproved('(MIT AND GPL-3.0)', approvedSet)) {
      throw new Error('self-test failed: (MIT AND GPL-3.0) should be rejected under AND');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Main execution.
 */
export function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  let policy;
  try {
    policy = loadPolicy(POLICY_FILE);
    selfTest(policy.approvedLicenses);
  } catch (err) {
    console.error(`license policy check FAIL: ${err.message}`);
    process.exit(1);
  }

  let prodPkgs;
  let installedMap;
  try {
    prodPkgs = getProductionDependencies(LOCK_FILE);
    installedMap = walkInstalledPackages(NODE_MODULES_DIR);
  } catch (err) {
    console.error(`dependency resolution FAIL: ${err.message}`);
    process.exit(1);
  }

  const { diagnostics, inventory } = checkLicenses(
    prodPkgs,
    installedMap,
    policy.approvedLicenses,
    policy.exceptions,
    new Date()
  );

  const hasFailures = diagnostics.some((d) => d.includes(' FAIL:'));

  if (jsonOutput) {
    inventory.sort((a, b) => a.package.localeCompare(b.package));
    console.log(JSON.stringify(inventory, null, 2));
    process.exit(hasFailures ? 1 : 0);
  }

  console.log('=== Production Dependency License Policy Check ===\n');
  console.log(diagnostics.join('\n'));
  console.log();

  if (hasFailures) {
    console.error('One or more production dependencies failed the license policy.');
    console.error(`Approved licenses: ${Array.from(policy.approvedLicenses).sort().join(', ')}`);
    console.error('Exceptions file: policies/license-policy.json');
    process.exit(1);
  }

  console.log(`${prodPkgs.size} production dependencies checked, all licenses declared and approved.`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
