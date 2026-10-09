#!/usr/bin/env node
/**
 * pipeline-run.mjs — Single-command apply pipeline
 *
 * Connects: scan → evaluate → tailor → cover-letter → apply
 *
 * Two tiers:
 *   Tier A (score 3.0–3.9): auto-submit after form fill
 *   Tier B (score 4.0+):    pause for manual review before submit
 *
 * Usage:
 *   node pipeline-run.mjs                        # full pipeline from scratch
 *   node pipeline-run.mjs --from-batch            # skip scan/eval, use existing batch results
 *   node pipeline-run.mjs --from-batch --apply-only  # skip tailor too, just apply
 *   node pipeline-run.mjs --min-score 3.5         # raise quality floor
 *   node pipeline-run.mjs --max-per-run 50        # cap applications per run
 *   node pipeline-run.mjs --tier-a-only           # only auto-submit tier
 *   node pipeline-run.mjs --tier-b-only           # only manual-review tier
 *   node pipeline-run.mjs --dry-run               # show queue without applying
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, execFileSync } from 'child_process';
import humanize from './humanize.mjs';
import { pickCV } from './archetype-cv.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// ── Flags ────────────────────────────────────────────────────────────────────
const FROM_BATCH   = args.includes('--from-batch');
const APPLY_ONLY   = args.includes('--apply-only');
const DRY_RUN      = args.includes('--dry-run');
const TIER_A_ONLY  = args.includes('--tier-a-only');
const TIER_B_ONLY  = args.includes('--tier-b-only');
const MIN_SCORE    = parseFloat(args.find(a => a.startsWith('--min-score='))?.split('=')[1] ?? '3.0');
const MAX_PER_RUN  = parseInt(args.find(a => a.startsWith('--max-per-run='))?.split('=')[1] ?? '300');
const SINCE_DAYS   = parseInt(args.find(a => a.startsWith('--since='))?.split('=')[1] ?? '7');

// ── Paths ────────────────────────────────────────────────────────────────────
const BATCH_STATE    = join(__dirname, 'batch', 'batch-state.tsv');
const REPORTS_DIR    = join(__dirname, 'reports');
const OUTPUT_DIR     = join(__dirname, 'output');
const QUEUE_FILE     = join(__dirname, 'batch', 'apply-queue.json');
const COVER_DIR      = join(OUTPUT_DIR, 'covers');

if (!existsSync(COVER_DIR)) mkdirSync(COVER_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) { console.log(msg); }
function sep()    { console.log('─'.repeat(60)); }

function readBatchState() {
  if (!existsSync(BATCH_STATE)) {
    console.error(`❌ No batch state at ${BATCH_STATE}. Run a batch evaluation first.`);
    process.exit(1);
  }
  const lines = readFileSync(BATCH_STATE, 'utf-8').split('\n').filter(Boolean);
  const header = lines[0].split('\t');
  const idxOf  = k => header.indexOf(k);

  return lines.slice(1).map(line => {
    const cols = line.split('\t');
    return {
      id:        cols[idxOf('id')],
      url:       cols[idxOf('url')],
      status:    cols[idxOf('status')],
      reportNum: cols[idxOf('report_num')],
      score:     parseFloat(cols[idxOf('score')]) || 0,
      error:     cols[idxOf('error')],
    };
  });
}

function findTailoredCV(reportNum, company) {
  // Look for output/cv-tanmay-sangam-*{company}*.pdf or output/*{reportNum}*.pdf
  if (!existsSync(OUTPUT_DIR)) return null;
  const files = readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.pdf'));
  // Try report num match first
  const byReport = files.find(f => f.includes(`-${reportNum}-`) || f.startsWith(`${reportNum}-`));
  if (byReport) return join(OUTPUT_DIR, byReport);
  // Try company slug match
  if (company) {
    const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const byCompany = files.find(f => f.toLowerCase().includes(slug));
    if (byCompany) return join(OUTPUT_DIR, byCompany);
  }
  return null;
}

function findReport(reportNum) {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  return files.find(f => f.startsWith(`${reportNum}-`) || f.startsWith(`0${reportNum}-`) || f.startsWith(`00${reportNum}-`)) ?? null;
}

function extractCompanyFromReport(reportPath) {
  try {
    const content = readFileSync(join(REPORTS_DIR, reportPath), 'utf-8');
    const match = content.match(/\*\*Company:\*\*\s*(.+)/);
    return match?.[1]?.trim() ?? null;
  } catch { return null; }
}

function extractRoleFromReport(reportPath) {
  try {
    const content = readFileSync(join(REPORTS_DIR, reportPath), 'utf-8');
    const match = content.match(/\*\*Role:\*\*\s*(.+)/);
    return match?.[1]?.trim() ?? null;
  } catch { return null; }
}

function determineTier(score) {
  if (score >= 4.0) return 'B'; // manual review
  if (score >= 3.0) return 'A'; // auto-submit
  return null; // skip
}

function generateCoverLetter(job) {
  const coverPath = join(COVER_DIR, `cover-${job.reportNum}-${Date.now()}.txt`);
  const prompt = `Generate a cover letter for this job application using the storytelling playbook (modes/cover-letter.md). Scene-first opening, one emotional truth, escalating proof, JD-mirrored close. Max 350 words. Never "I am excited to apply." Output ONLY the cover letter text, nothing else.\n\nCompany: ${job.company ?? 'the company'}\nRole: ${job.role ?? 'this role'}\nURL: ${job.url}\n${job.reportPath ? `Report: ${join(REPORTS_DIR, job.reportPath)}` : ''}`;

  log(`  📝 Generating cover letter for ${job.company ?? job.url}...`);
  const res = spawnSync('claude', [
    '-p',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file', join(__dirname, 'modes', 'cover-letter.md'),
    prompt,
  ], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10 });

  if (res.error || res.status !== 0) {
    log(`  ⚠️  Cover letter generation failed: ${res.error?.message ?? res.stderr?.slice(0, 100)}`);
    return null;
  }
  writeFileSync(coverPath, humanize(res.stdout.trim()));
  return coverPath;
}

// ── Step 1: Scan (unless --from-batch) ───────────────────────────────────────
if (!FROM_BATCH) {
  sep();
  log(`\n🔍 STEP 1: Scanning for fresh roles (--since ${SINCE_DAYS} days)...`);
  const scanRes = spawnSync('node', [join(__dirname, 'scan.mjs'), '--since', String(SINCE_DAYS)], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  if (scanRes.status !== 0) log('⚠️  Scan completed with warnings — continuing.');
}

// ── Step 2: Evaluate (unless --from-batch) ────────────────────────────────────
if (!FROM_BATCH) {
  sep();
  log('\n⚡ STEP 2: Running batch evaluation (8 parallel workers)...');
  log('   This runs overnight. Use --from-batch to skip on subsequent runs.');
  const batchRes = spawnSync('bash', [join(__dirname, 'batch', 'batch-runner.sh')], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  if (batchRes.status !== 0) log('⚠️  Batch evaluation completed with some failures — continuing with completed rows.');
}

// ── Step 3: Read batch results ────────────────────────────────────────────────
sep();
log('\n📊 STEP 3: Reading batch results...');
const allJobs = readBatchState();
const completed = allJobs.filter(j => j.status === 'completed' && j.score >= MIN_SCORE);
log(`   Total evaluated: ${allJobs.length}`);
log(`   Passing score >= ${MIN_SCORE}: ${completed.length}`);

// Attach metadata from reports
const enriched = completed.map(job => {
  const reportPath = findReport(job.reportNum);
  const company    = reportPath ? extractCompanyFromReport(reportPath) : null;
  const role       = reportPath ? extractRoleFromReport(reportPath) : null;
  const tier       = determineTier(job.score);
  return { ...job, reportPath, company, role, tier };
}).filter(j => j.tier !== null);

// Apply tier filters
const queue = enriched
  .filter(j => {
    if (TIER_A_ONLY && j.tier !== 'A') return false;
    if (TIER_B_ONLY && j.tier !== 'B') return false;
    return true;
  })
  .slice(0, MAX_PER_RUN);

const tierA = queue.filter(j => j.tier === 'A');
const tierB = queue.filter(j => j.tier === 'B');

log(`\n   Tier A (auto-submit,  3.0-3.9): ${tierA.length} roles`);
log(`   Tier B (manual review, 4.0+):   ${tierB.length} roles`);
log(`   Total to apply:                  ${queue.length}`);

if (DRY_RUN) {
  sep();
  log('\n🔍 DRY RUN — queue preview:');
  queue.forEach((j, i) => {
    log(`  [${i+1}] ${j.tier} | ${j.score}/5 | ${j.company ?? 'Unknown'} — ${j.role ?? 'Unknown'} | ${j.url}`);
  });
  log('\nDry run complete. Remove --dry-run to execute.');
  process.exit(0);
}

// ── Step 4: Tailor CVs (unless --apply-only) ──────────────────────────────────
if (!APPLY_ONLY) {
  sep();
  log('\n📄 STEP 4: Tailoring CVs for qualifying roles...');
  const tailorRes = spawnSync('node', [
    join(__dirname, 'batch-tailor.mjs'),
    `--min-score=${MIN_SCORE}`,
  ], { stdio: 'inherit', cwd: __dirname });
  if (tailorRes.status !== 0) log('⚠️  Some CVs failed to tailor — will use fallback CV for those roles.');
}

// ── Step 5: Generate cover letters ───────────────────────────────────────────
sep();
log('\n✍️  STEP 5: Generating cover letters...');
const FALLBACK_CV = join(OUTPUT_DIR, 'tanmay-sangam-tesla-pm-sales-delivery.pdf');

const applyQueue = [];
for (const job of queue) {
  const cv = findTailoredCV(job.reportNum, job.company)
          ?? pickCV(job.role ?? '', job.company ?? '')
          ?? FALLBACK_CV;
  const coverPath = generateCoverLetter(job);
  applyQueue.push({
    id:         parseInt(job.id),
    reportNum:  job.reportNum,
    company:    job.company ?? 'Unknown',
    role:       job.role ?? 'Unknown',
    score:      `${job.score}/5`,
    url:        job.url,
    platform:   /greenhouse/i.test(job.url) ? 'greenhouse'
              : /lever/i.test(job.url)      ? 'lever'
              : /ashby/i.test(job.url)      ? 'ashby'
              : /workday/i.test(job.url)    ? 'workday'
              : 'generic',
    tier:       job.tier,
    autoSubmit: job.tier === 'A',
    cv,
    cover:      coverPath ? readFileSync(coverPath, 'utf-8') : '',
  });
}

// Save queue for apply-batch
writeFileSync(QUEUE_FILE, JSON.stringify(applyQueue, null, 2));
log(`\n✅ Apply queue saved: ${QUEUE_FILE} (${applyQueue.length} roles)`);

// ── Step 6: Apply ─────────────────────────────────────────────────────────────
sep();
log('\n🚀 STEP 6: Launching apply-batch...');
log(`   Tier A (auto-submit): ${tierA.length}`);
log(`   Tier B (manual):      ${tierB.length}`);
log('\n   ⚠️  Tier A roles will auto-submit. Tier B will pause for your review.\n');

const batchRes = spawnSync('node', [
  join(__dirname, 'apply-batch-v2.mjs'),
  '--queue', QUEUE_FILE,
], { stdio: 'inherit', cwd: __dirname });

if (batchRes.status !== 0) {
  log('⚠️  Apply batch completed with some failures.');
} else {
  log('\n✅ Pipeline complete.');
}

sep();
log('\n📋 Post-run steps:');
log('   1. node merge-tracker.mjs        — sync applied roles to tracker');
log('   2. node network-lookup.mjs       — check LinkedIn connections for new roles');
log('   3. node verify-pipeline.mjs      — health check\n');
