#!/usr/bin/env node
/**
 * prep-batch.mjs — Bridge: scan output → batch-runner input
 *
 * Reads newly discovered URLs from:
 *   1. data/scan-history.tsv  (status = 'added', freshly scanned)
 *   2. data/pipeline.md       (unchecked `- [ ]` lines)
 *
 * Deduplicates against:
 *   - batch/batch-state.tsv  (already evaluated)
 *   - batch/batch-input.tsv  (already queued)
 *
 * Appends new entries to batch/batch-input.tsv.
 *
 * Usage:
 *   node prep-batch.mjs                 # pull from scan-history + pipeline.md
 *   node prep-batch.mjs --dry-run       # preview without writing
 *   node prep-batch.mjs --since 7       # only scan-history entries from last N days
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const SINCE_DAYS = parseInt(args.find(a => a.startsWith('--since='))?.split('=')[1] ?? args[args.indexOf('--since') + 1] ?? '7');

const SCAN_HISTORY  = join(__dirname, 'data', 'scan-history.tsv');
const PIPELINE_MD   = join(__dirname, 'data', 'pipeline.md');
const BATCH_INPUT   = join(__dirname, 'batch', 'batch-input.tsv');
const BATCH_STATE   = join(__dirname, 'batch', 'batch-state.tsv');

// ── Collect already-known URLs ────────────────────────────────────────────────
const knownUrls = new Set();

if (existsSync(BATCH_STATE)) {
  readFileSync(BATCH_STATE, 'utf-8').split('\n').filter(Boolean).slice(1).forEach(line => {
    const url = line.split('\t')[1];
    if (url) knownUrls.add(url.trim());
  });
}

if (existsSync(BATCH_INPUT)) {
  readFileSync(BATCH_INPUT, 'utf-8').split('\n').filter(Boolean).slice(1).forEach(line => {
    const url = line.split('\t')[1];
    if (url) knownUrls.add(url.trim());
  });
}

// ── Read new URLs ─────────────────────────────────────────────────────────────
const candidates = []; // { url, source, notes }

// From scan-history.tsv
if (existsSync(SCAN_HISTORY)) {
  const cutoff = new Date(Date.now() - SINCE_DAYS * 86_400_000);
  const lines  = readFileSync(SCAN_HISTORY, 'utf-8').split('\n').filter(Boolean);
  const header = lines[0].split('\t');
  const iUrl   = header.indexOf('url');
  const iSeen  = header.indexOf('first_seen');
  const iTitle = header.indexOf('title');
  const iCo    = header.indexOf('company');
  const iSt    = header.indexOf('status');

  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const url  = cols[iUrl]?.trim();
    const st   = cols[iSt]?.trim();
    const seen = cols[iSeen]?.trim();
    if (!url || st !== 'added') continue;
    if (seen && new Date(seen) < cutoff) continue;
    const co    = cols[iCo]?.trim() ?? '';
    const title = cols[iTitle]?.trim() ?? '';
    candidates.push({ url, source: 'scan', notes: `${co} — ${title}`.trim() });
  }
}

// From pipeline.md
if (existsSync(PIPELINE_MD)) {
  const urlRe = /^-\s+\[\s+\]\s+(https?:\/\/\S+)\s*(?:\|\s*([^|]+))?\s*(?:\|\s*(.+))?/;
  for (const line of readFileSync(PIPELINE_MD, 'utf-8').split('\n')) {
    const m = line.match(urlRe);
    if (!m) continue;
    const url  = m[1].trim();
    const co   = m[2]?.trim() ?? '';
    const role = m[3]?.trim() ?? '';
    candidates.push({ url, source: 'pipeline', notes: `${co} — ${role}`.trim() });
  }
}

// ── Deduplicate ───────────────────────────────────────────────────────────────
const newEntries = candidates.filter(c => !knownUrls.has(c.url));

if (newEntries.length === 0) {
  console.log('prep-batch: no new URLs to add.');
  process.exit(0);
}

// ── Assign IDs ────────────────────────────────────────────────────────────────
let maxId = 0;
if (existsSync(BATCH_INPUT)) {
  readFileSync(BATCH_INPUT, 'utf-8').split('\n').filter(Boolean).slice(1).forEach(line => {
    const id = parseInt(line.split('\t')[0]);
    if (!isNaN(id) && id > maxId) maxId = id;
  });
}

// ── Write ─────────────────────────────────────────────────────────────────────
const header = 'id\turl\tsource\tnotes';

if (!existsSync(BATCH_INPUT)) {
  if (!DRY_RUN) writeFileSync(BATCH_INPUT, header + '\n');
}

const rows = newEntries.map((e, i) => {
  const id = maxId + i + 1;
  return `${id}\t${e.url}\t${e.source}\t${e.notes}`;
});

if (DRY_RUN) {
  console.log(`prep-batch (dry run): ${newEntries.length} new URLs would be added:`);
  rows.slice(0, 20).forEach(r => console.log('  ' + r));
  if (rows.length > 20) console.log(`  ... and ${rows.length - 20} more`);
} else {
  appendFileSync(BATCH_INPUT, rows.join('\n') + '\n');
  console.log(`prep-batch: added ${newEntries.length} new URLs to batch-input.tsv`);
}
