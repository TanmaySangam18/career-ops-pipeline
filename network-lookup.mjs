#!/usr/bin/env node
/**
 * network-lookup.mjs — Auto LinkedIn connection check after tracker merge
 *
 * Reads the latest N entries from applications.md, runs linkedin-join --company
 * for each, and surfaces any connections. Run after merge-tracker.mjs.
 *
 * Usage:
 *   node network-lookup.mjs              # check last 5 tracker entries
 *   node network-lookup.mjs --last 10    # check last N entries
 *   node network-lookup.mjs --company "Tesla"  # check one company directly
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const companyArg = args.includes('--company') ? args[args.indexOf('--company') + 1] : null;
const lastN = args.includes('--last') ? parseInt(args[args.indexOf('--last') + 1]) || 5 : 5;

const APPS_FILE = join(__dirname, 'data', 'applications.md');

function extractRecentCompanies(n) {
  if (!existsSync(APPS_FILE)) {
    console.error(`❌ Tracker not found at ${APPS_FILE}`);
    process.exit(1);
  }
  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');
  const dataRows = lines.filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('Company'));
  const recent = dataRows.slice(-n);
  return recent.map(row => {
    const cols = row.split('|').map(c => c.trim()).filter(Boolean);
    return cols[2]; // Company column (0=num, 1=date, 2=company)
  }).filter(Boolean);
}

function runLinkedInCheck(company) {
  console.log(`\n🔍 Checking LinkedIn connections at: ${company}`);
  console.log('─'.repeat(50));
  try {
    execFileSync(
      process.execPath,
      [join(__dirname, 'linkedin-join.mjs'), '--company', company, '--summary'],
      { stdio: 'inherit' }
    );
  } catch {
    // linkedin-join exits 1 when no connections found — that's fine
  }
}

if (companyArg) {
  runLinkedInCheck(companyArg);
} else {
  const companies = extractRecentCompanies(lastN);
  if (companies.length === 0) {
    console.log('No recent tracker entries found.');
    process.exit(0);
  }
  console.log(`\n📋 Checking LinkedIn connections for last ${companies.length} tracker entries...\n`);
  const seen = new Set();
  for (const company of companies) {
    if (seen.has(company)) continue;
    seen.add(company);
    runLinkedInCheck(company);
  }
  console.log('\n✅ Network lookup complete.');
}
