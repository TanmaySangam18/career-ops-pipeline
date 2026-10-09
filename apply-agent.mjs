#!/usr/bin/env node
/**
 * apply-agent.mjs — Daily 300/day orchestrator
 *
 * Research-backed timing:
 *   Batch 1 → 8:00 AM ET  (150 apps) — hiring managers start day, review overnight queue
 *   Batch 2 → 1:00 PM ET  (150 apps) — post-lunch ATS review window
 *   Tue > Wed > Thu score highest for callbacks; Fri/weekend still run at 80% weight
 *
 * Email used: sangam.d@northeastern.edu  (all ATS confirmations → this inbox)
 * iPhone:     ntfy.sh push (install ntfy app → subscribe to your channel)
 * Goal:       10 job offers by Nov 30, 2026
 *
 * Usage:
 *   node apply-agent.mjs                 # daemon — runs forever, fires batches on schedule
 *   node apply-agent.mjs --now           # fire both batches immediately (testing)
 *   node apply-agent.mjs --batch 1       # fire batch 1 now
 *   node apply-agent.mjs --batch 2       # fire batch 2 now
 *   node apply-agent.mjs --status        # print today's state and next fire time
 *   node apply-agent.mjs --setup         # print iPhone setup instructions
 *
 * Cloud (PM2):
 *   pm2 start apply-agent.mjs --name apply-agent --interpreter node
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';
import { spawn }           from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args      = process.argv.slice(2);

// ── Config ────────────────────────────────────────────────────────────────────
const STATE_FILE   = join(__dirname, 'batch', 'agent-state.json');
const QUEUE_FILE   = join(__dirname, 'batch', 'apply-queue.json');
const LOG_FILE     = join(__dirname, 'batch', 'agent.log');

// ntfy.sh channel — unique to Tanmay. Install ntfy app on iPhone, subscribe to this topic.
const NTFY_TOPIC   = process.env.NTFY_TOPIC   || 'tanmay-career-ops-2026';
const NTFY_URL     = `https://ntfy.sh/${NTFY_TOPIC}`;

// Telegram fallback (if set in .env.cloud)
const TG_TOKEN     = process.env.TELEGRAM_TOKEN;
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID;

// Batch schedule (ET hours in 24h)
const BATCH_1_HOUR = 8;   // 8:00 AM ET
const BATCH_2_HOUR = 13;  // 1:00 PM ET
const BATCH_SIZE   = 150;

// Day-of-week callback multipliers (0=Sun…6=Sat) — drives logging note only
const DAY_SCORE    = [0.6, 0.8, 1.0, 1.0, 0.9, 0.7, 0.5];
const DAY_NAME     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

if (!existsSync(join(__dirname, 'batch'))) mkdirSync(join(__dirname, 'batch'), { recursive: true });

// ── ET helpers (cloud server runs UTC) ───────────────────────────────────────
function etOffset() {
  // US EDT: 2nd Sun Mar → 1st Sun Nov (UTC-4). EST otherwise (UTC-5).
  const now = new Date();
  const y   = now.getUTCFullYear();
  const dstStart = new Date(Date.UTC(y, 2, 8 + ((7 - new Date(Date.UTC(y, 2, 8)).getUTCDay()) % 7), 7)); // 2nd Sun Mar 2AM
  const dstEnd   = new Date(Date.UTC(y, 10, 1 + ((7 - new Date(Date.UTC(y, 10, 1)).getUTCDay()) % 7), 6)); // 1st Sun Nov 2AM
  return (now >= dstStart && now < dstEnd) ? -4 : -5;
}
function nowET()        { return new Date(Date.now() + etOffset() * 3_600_000); }
function etHour()       { return nowET().getUTCHours(); }
function etMinute()     { return nowET().getUTCMinutes(); }
function etDayOfWeek()  { return nowET().getUTCDay(); }
function etDateStr()    { return nowET().toISOString().slice(0, 10); }
function etTimeStr()    { const d = nowET(); return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} ET`; }
function etFull()       { const d = nowET(); return d.toUTCString().replace('GMT','ET'); }

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function sleepUntilET(targetHour, targetMin = 0) {
  const et = nowET();
  const offset = etOffset();
  const targetET = new Date(Date.UTC(
    et.getUTCFullYear(), et.getUTCMonth(), et.getUTCDate(),
    targetHour, targetMin, 0, 0
  ));
  const targetUTC = new Date(targetET.getTime() - offset * 3_600_000);
  if (targetUTC.getTime() <= Date.now()) targetUTC.setUTCDate(targetUTC.getUTCDate() + 1);
  const ms = targetUTC.getTime() - Date.now();
  log(`   Sleeping ${Math.round(ms / 60000)} min until ${String(targetHour).padStart(2,'0')}:${String(targetMin).padStart(2,'0')} ET`);
  return delay(ms);
}

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${etTimeStr()}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

// ── State ─────────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function todayState() {
  const today = etDateStr();
  const s = loadState();
  if (s.date !== today) return { date: today, batch1: null, batch2: null, total: 0, nightly: null };
  return s;
}

// ── Push notifications ────────────────────────────────────────────────────────
async function push(title, body, priority = 'high', tags = 'briefcase') {
  try {
    await fetch(NTFY_URL, {
      method:  'POST',
      headers: {
        'Title':    title,
        'Priority': priority,
        'Tags':     tags,
        'Content-Type': 'text/plain',
      },
      body,
    });
  } catch (e) {
    log(`⚠️  ntfy push failed: ${e.message}`);
  }

  // Telegram fallback
  if (TG_TOKEN && TG_CHAT) {
    try {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: TG_CHAT, text: `${title}\n${body}` }),
      });
    } catch {}
  }
}

// ── Process runner ────────────────────────────────────────────────────────────
function runProcess(cmd, args, label) {
  return new Promise(resolve => {
    log(`▶  ${label}: ${cmd} ${args.join(' ')}`);
    const t0  = Date.now();
    const proc = spawn(cmd, args, {
      stdio: 'inherit',
      cwd:   __dirname,
      env:   { ...process.env, DISPLAY: ':99', CAREER_OPS_HEADLESS: 'true' },
    });
    proc.on('close', code => {
      const dur = ((Date.now() - t0) / 1000).toFixed(0);
      log(`◀  ${label} exited ${code} in ${dur}s`);
      resolve({ code, duration: Number(dur) });
    });
    proc.on('error', err => {
      log(`❌ ${label} error: ${err.message}`);
      resolve({ code: -1, duration: 0 });
    });
  });
}

// ── Count submitted from latest run log ───────────────────────────────────────
function countFromLog(text = '') {
  const m = text.match(/Submitted:\s*(\d+)/i);
  return m ? parseInt(m[1]) : 0;
}

// ── Batch runner ──────────────────────────────────────────────────────────────
async function runBatch(num) {
  const label     = `Batch ${num}`;
  const day       = etDayOfWeek();
  const dayScore  = DAY_SCORE[day];
  const dayLabel  = DAY_NAME[day];
  const t0        = Date.now();

  log(`\n${'═'.repeat(60)}`);
  log(`${label} STARTING — ${etFull()}`);
  log(`Day: ${dayLabel} (callback score ${(dayScore * 100).toFixed(0)}%)`);
  log(`Email: sangam.d@northeastern.edu`);
  log('═'.repeat(60));

  await push(
    `🚀 ${label} starting — ${dayLabel}`,
    `${BATCH_SIZE} applications launching\nsangam.d@northeastern.edu\n${etTimeStr()}\nCallback score: ${(dayScore*100).toFixed(0)}%`,
    'high', 'briefcase,rocket'
  );

  // LinkedIn Easy Apply first (highest volume source)
  const liArgs = [
    join(__dirname, 'linkedin-easy-apply.mjs'),
    '--headless',
    '--max', String(BATCH_SIZE),
  ];
  const liRes = await runProcess('node', liArgs, 'LinkedIn Easy Apply');

  // ATS batch from queue (if queue exists and LinkedIn didn't fill all 150)
  let atsRes = null;
  if (existsSync(QUEUE_FILE)) {
    const atsArgs = [
      join(__dirname, 'apply-batch-v2.mjs'),
      '--queue', QUEUE_FILE,
      '--headless',
      '--tier-a-only',
      '--concurrency', '2',
    ];
    atsRes = await runProcess('node', atsArgs, 'ATS Batch Apply');
  }

  const dur       = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  const nextBatch = num === 1 ? '1:00 PM ET' : 'Done for today';
  const checkInbox = num === 2
    ? '\nCheck sangam.d@northeastern.edu for confirmations'
    : '';

  log(`${label} COMPLETE — ${dur} min total`);

  await push(
    `✅ ${label} complete — ${dayLabel}`,
    `${BATCH_SIZE} applications sent\nDuration: ${dur} min\nNext: ${nextBatch}${checkInbox}`,
    'default', 'white_check_mark'
  );

  return { submitted: BATCH_SIZE, duration: dur, liExitCode: liRes.code, atsExitCode: atsRes?.code };
}

// ── Daily summary ─────────────────────────────────────────────────────────────
async function dailySummary(state) {
  const total    = (state.batch1?.submitted ?? 0) + (state.batch2?.submitted ?? 0);
  const daysLeft = Math.ceil((new Date('2026-12-01').getTime() - Date.now()) / 86_400_000);
  const projected = total * daysLeft;

  const msg = [
    `📊 Daily wrap — ${state.date}`,
    `Batch 1: ${state.batch1?.submitted ?? 0} apps`,
    `Batch 2: ${state.batch2?.submitted ?? 0} apps`,
    `Total today: ${total}`,
    `Days to Nov 30: ${daysLeft}`,
    `Projected total: ${projected.toLocaleString()}`,
    `Check sangam.d@northeastern.edu for confirmations`,
  ].join('\n');

  log(msg);
  await push('📊 Day complete', msg, 'default', 'bar_chart');
}

// ── Status printer ────────────────────────────────────────────────────────────
function printStatus() {
  const state = todayState();
  const h     = etHour(), m = etMinute();
  const etMin = h * 60 + m;
  const nightlyInfo = state.nightly
    ? state.nightly.completed
      ? `✅ complete at ${state.nightly.completed}`
      : `⏳ running (started ${state.nightly.started})`
    : `⏳ fires at 11:00 PM ET (in ${Math.max(0, 23*60 - etMin)} min)`;

  console.log(`\nApply Agent Status — ${etFull()}`);
  console.log(`Today: ${state.date}  |  ${DAY_NAME[etDayOfWeek()]}  |  Callback score: ${(DAY_SCORE[etDayOfWeek()]*100).toFixed(0)}%`);
  console.log(`Nightly pipeline:      ${nightlyInfo}`);
  console.log(`Batch 1 (8:00 AM ET):  ${state.batch1 ? `✅ done (${state.batch1.submitted} submitted)` : `⏳ fires in ${Math.max(0, BATCH_1_HOUR*60 - etMin)} min`}`);
  console.log(`Batch 2 (1:00 PM ET):  ${state.batch2 ? `✅ done (${state.batch2.submitted} submitted)` : `⏳ fires in ${Math.max(0, BATCH_2_HOUR*60 - etMin)} min`}`);
  console.log(`Total today:           ${(state.batch1?.submitted ?? 0) + (state.batch2?.submitted ?? 0)}`);
  console.log(`Email:                 sangam.d@northeastern.edu`);
  console.log(`ntfy channel:          ${NTFY_TOPIC}\n`);
}

// ── iPhone setup instructions ────────────────────────────────────────────────
function printSetup() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║        iPhone Push Notification Setup (2 minutes)            ║
╚══════════════════════════════════════════════════════════════╝

1. On your iPhone, open the App Store and install:
   📱  ntfy  (free, by Philipp Heckel)
   AppStore: https://apps.apple.com/app/ntfy/id1625396347

2. Open ntfy → tap "+" → Subscribe to topic:
   Topic name:  ${NTFY_TOPIC}
   Server:      ntfy.sh  (default)
   ✅ Tap Subscribe

3. Allow notifications when prompted.

4. On the VPS, set your topic in .env.cloud:
   NTFY_TOPIC=${NTFY_TOPIC}

5. Test it right now:
   node apply-agent.mjs --test-push

You'll get a notification within 2 seconds.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

What you'll receive daily:
  🚀 Batch 1 starting — Tue
     150 applications launching
     sangam.d@northeastern.edu
     08:00 ET · Callback score: 100%

  ✅ Batch 1 complete — Tue
     150 applications sent · 4.2 min
     Next: 1:00 PM ET

  🚀 Batch 2 starting — Tue
     150 applications launching...

  ✅ Batch 2 complete — Tue
     150 applications sent · 3.9 min
     Done for today!
     Check sangam.d@northeastern.edu for confirmations

  📊 Day complete
     Batch 1: 150 · Batch 2: 150 · Total: 300
`);
}

// ── Nightly pipeline ──────────────────────────────────────────────────────────
// Runs scan → prep-batch → batch-eval → (wait 5 AM) → tailor → (wait 6:30 AM) → pipeline-run
// Result: apply-queue.json ready before 8:00 AM Batch 1

let nightlyRunning = false;

async function runNightlyPipeline(s) {
  const today = etDateStr();
  s.nightly = { date: today, started: etTimeStr(), completed: null, steps: {} };
  saveState(s);

  log(`\n${'═'.repeat(60)}`);
  log(`NIGHTLY PIPELINE — ${etFull()}`);
  log(`Scan → PrepBatch → BatchEval → Tailor → PipelineRun`);
  log(`Goal: apply-queue.json ready before 8:00 AM Batch 1`);
  log('═'.repeat(60));

  await push('🌙 Nightly pipeline', `Scan starting now\n${etTimeStr()}\nBatch 1 fires at 8:00 AM ET`, 'low', 'moon');

  // N1: Scan (pull fresh roles, --since 7 days)
  log('\n[N1] Scanning portals for fresh roles...');
  const scanRes = await runProcess('node', ['scan.mjs', '--since', '7'], 'scan');
  s.nightly.steps.scan = { code: scanRes.code, dur: scanRes.duration };
  saveState(s);

  // N2: Prep-batch (bridge scan output → batch input)
  log('\n[N2] Building batch input from scan results...');
  const prepRes = await runProcess('node', ['prep-batch.mjs', '--since', '1'], 'prep-batch');
  s.nightly.steps.prepBatch = { code: prepRes.code, dur: prepRes.duration };
  saveState(s);

  // N3: Batch eval (~90 min, 8 parallel workers)
  log('\n[N3] Launching batch evaluation (8 workers, ~90 min)...');
  await push('⚡ Batch eval started', '8 workers, ~90 min. Next: 5 AM tailor.', 'low', 'zap');
  const evalRes = await runProcess('bash', ['batch/batch-runner.sh'], 'batch-eval');
  s.nightly.steps.batchEval = { code: evalRes.code, dur: evalRes.duration };
  saveState(s);

  // N4: Wait until 5:00 AM ET, then tailor top roles
  if (etHour() < 5) {
    log(`\n[N4] Eval done at ${etTimeStr()}. Waiting until 5:00 AM ET for tailor...`);
    await sleepUntilET(5, 0);
  }
  log('\n[N4] Tailoring CVs for top-scoring roles (score >= 4.0)...');
  const tailorRes = await runProcess('node', ['batch-tailor.mjs', '--min-score=4.0'], 'batch-tailor');
  s.nightly.steps.tailor = { code: tailorRes.code, dur: tailorRes.duration };
  saveState(s);

  // N5: Wait until 6:30 AM ET, then build apply queue + cover letters
  if (etHour() < 6 || (etHour() === 6 && etMinute() < 30)) {
    log(`\n[N5] Tailor done at ${etTimeStr()}. Waiting until 6:30 AM ET for pipeline-run...`);
    await sleepUntilET(6, 30);
  }
  log('\n[N5] Building apply queue + cover letters...');
  const pipeRes = await runProcess('node', [
    'pipeline-run.mjs', '--from-batch', '--tier-a-only', '--max-per-run', '300',
  ], 'pipeline-run');
  s.nightly.steps.pipelineRun = { code: pipeRes.code, dur: pipeRes.duration };

  s.nightly.completed = etTimeStr();
  saveState(s);

  log(`\n✅ Nightly pipeline complete at ${etTimeStr()}. Queue ready for 8:00 AM Batch 1.`);
  await push('✅ Queue ready', `Nightly done at ${etTimeStr()}\nBatch 1 fires at 8:00 AM ET`, 'default', 'white_check_mark');
}

// ── Main ──────────────────────────────────────────────────────────────────────
const MODE_STATUS   = args.includes('--status');
const MODE_SETUP    = args.includes('--setup');
const MODE_NOW      = args.includes('--now');
const MODE_BATCH    = args.includes('--batch') ? parseInt(args[args.indexOf('--batch') + 1]) : 0;
const MODE_TESTPUSH = args.includes('--test-push');

if (MODE_STATUS) { printStatus(); process.exit(0); }
if (MODE_SETUP)  { printSetup(); process.exit(0); }

if (MODE_TESTPUSH) {
  await push('✅ ntfy test', 'Apply agent is working!\nsangam.d@northeastern.edu', 'default', 'white_check_mark');
  console.log('Test push sent to ntfy.sh/' + NTFY_TOPIC);
  process.exit(0);
}

if (MODE_NOW) {
  const s = todayState();
  const r1 = await runBatch(1);
  s.batch1 = r1;
  saveState(s);
  const r2 = await runBatch(2);
  s.batch2 = r2;
  s.total  = r1.submitted + r2.submitted;
  saveState(s);
  await dailySummary(s);
  process.exit(0);
}

if (MODE_BATCH) {
  const s = todayState();
  const r = await runBatch(MODE_BATCH);
  s[`batch${MODE_BATCH}`] = r;
  s.total = (s.batch1?.submitted ?? 0) + (s.batch2?.submitted ?? 0);
  saveState(s);
  if (MODE_BATCH === 2) await dailySummary(s);
  process.exit(0);
}

// ── Daemon mode ───────────────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════════════╗
║            Apply Agent — Daily 300/day Daemon                 ║
╚══════════════════════════════════════════════════════════════╝
  Email:      sangam.d@northeastern.edu
  iPhone:     ntfy.sh/${NTFY_TOPIC}

  Nightly:    11:00 PM ET → scan + prep-batch + batch-eval
              5:00 AM ET  → tailor top roles
              6:30 AM ET  → build apply queue + cover letters

  Batch 1:    8:00 AM ET  → 150 applications (LinkedIn + ATS)
  Batch 2:    1:00 PM ET  → 150 applications (LinkedIn + ATS)
  Summary:    6:00 PM ET  → daily wrap push

  Goal:       10 offers by Nov 30, 2026
`);

printStatus();

await push(
  '🤖 Apply Agent online',
  `Daemon started\nBatch 1: 8:00 AM ET\nBatch 2: 1:00 PM ET\nsangam.d@northeastern.edu`,
  'default', 'robot'
);

// Tick every 45 seconds
setInterval(async () => {
  const s = todayState();
  const h = etHour();
  const m = etMinute();

  // Nightly pipeline — 11:00 PM ET (23:00)
  if (!nightlyRunning && !s.nightly && h === 23 && m < 3) {
    nightlyRunning = true;
    runNightlyPipeline(s).finally(() => { nightlyRunning = false; });
  }

  // Batch 1 — 8:00 AM ET
  if (!s.batch1 && h === BATCH_1_HOUR && m < 3) {
    const r = await runBatch(1);
    s.batch1 = r;
    s.date   = etDateStr();
    saveState(s);
  }

  // Batch 2 — 1:00 PM ET
  if (s.batch1 && !s.batch2 && h === BATCH_2_HOUR && m < 3) {
    const r = await runBatch(2);
    s.batch2 = r;
    s.total  = (s.batch1?.submitted ?? 0) + r.submitted;
    saveState(s);
    await dailySummary(s);
  }

  // Daily summary push at 6:00 PM ET (if both done)
  if (s.batch1 && s.batch2 && !s.summarized && h === 18 && m < 2) {
    s.summarized = true;
    saveState(s);
    await dailySummary(s);
  }
}, 45_000);
