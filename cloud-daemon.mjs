import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env ───────────────────────────────────────────────────────────────────────
const envFile = join(__dirname, '.env.cloud');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] ??= m[2].trim();
  }
}

// ── Xvfb ──────────────────────────────────────────────────────────────────────
process.env.DISPLAY = ':99';
spawnSync('Xvfb', [':99', '-screen', '0', '1280x720x24'], { detached: true, stdio: 'ignore' });

// ── schedule ──────────────────────────────────────────────────────────────────
const STEPS = [
  { id: 1, name: 'Scan fresh roles',    utcH: 23, utcM:  0, cmd: 'node', args: ['scan.mjs', '--since', '7'] },
  { id: 2, name: 'Batch evaluation',    utcH:  0, utcM: 30, cmd: 'bash', args: ['batch/batch-runner.sh'] },
  { id: 3, name: 'Tailor + covers',     utcH:  7, utcM:  0, cmd: 'node', args: ['pipeline-run.mjs', '--from-batch'] },
  { id: 4, name: 'LinkedIn Easy Apply', utcH:  8, utcM:  0, cmd: 'node', args: ['linkedin-easy-apply.mjs', '--headless', '--max', '150'] },
  { id: 5, name: 'ATS batch apply',     utcH:  9, utcM:  0, cmd: 'node', args: ['apply-batch-v2.mjs', '--headless', '--queue', 'batch/apply-queue.json', '--tier-a-only'] },
  { id: 6, name: 'Merge tracker',       utcH: 10, utcM:  0, cmd: 'node', args: ['merge-tracker.mjs'] },
  { id: 7, name: 'Network lookup',      utcH: 10, utcM: 30, cmd: 'node', args: ['network-lookup.mjs', '--last', '20'] },
  { id: 8, name: 'Daily summary',       utcH: 11, utcM:  0, cmd: null,   args: [] },
];

// ── state ─────────────────────────────────────────────────────────────────────
const STATE_FILE = join(__dirname, 'batch', 'daemon-state.json');
let state = {};
try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const today = todayUTC();
  if (state._day !== today) {
    state = { _day: today };
    saveState();
  }
}

// ── telegram ──────────────────────────────────────────────────────────────────
async function notify(msg) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ── step runner ───────────────────────────────────────────────────────────────
function runStep(name, cmd, args) {
  return new Promise((resolve) => {
    const t = Date.now();
    const proc = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, DISPLAY: ':99' },
    });
    proc.on('close', (code) => {
      const dur = ((Date.now() - t) / 1000).toFixed(0);
      resolve({ name, code, dur });
    });
  });
}

async function dailySummary() {
  const logDir = join(__dirname, 'batch', 'logs');
  let submitted = 0, errors = 0;
  try {
    const files = readdirSyncSafe(logDir);
    const today = todayUTC().replace(/-/g, '');
    for (const f of files.filter(n => n.includes(today))) {
      const txt = readFileSync(join(logDir, f), 'utf8');
      submitted += (txt.match(/submitted/gi) || []).length;
      errors    += (txt.match(/error|failed/gi) || []).length;
    }
  } catch {}
  await notify(`📊 <b>Daily summary</b>\nSubmitted: ${submitted}\nErrors: ${errors}`);
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

// ── ticker ────────────────────────────────────────────────────────────────────
setInterval(async () => {
  resetIfNewDay();
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();

  for (const step of STEPS) {
    const key = `step_${step.id}`;
    if (state[key]) continue;
    if (step.utcH !== h || step.utcM !== m) continue;

    state[key] = new Date().toISOString();
    saveState();

    if (step.id === 8) {
      await dailySummary();
      continue;
    }

    await notify(`🚀 Step ${step.id}: ${step.name} starting...`);
    const result = await runStep(step.name, step.cmd, step.args);
    if (result.code === 0) {
      await notify(`✅ Step ${step.id} done in ${result.dur}s`);
    } else {
      await notify(`❌ Step ${step.id} failed (exit ${result.code}) after ${result.dur}s`);
    }
  }
}, 60_000);

// ── status HTTP ───────────────────────────────────────────────────────────────
createServer((req, res) => {
  resetIfNewDay();
  const lines = [`career-ops daemon — ${new Date().toUTCString()}`, ''];
  for (const step of STEPS) {
    const key = `step_${step.id}`;
    const ran = state[key] ? `ran ${state[key]}` : 'pending';
    lines.push(`Step ${step.id} (${String(step.utcH).padStart(2,'0')}:${String(step.utcM).padStart(2,'0')} UTC) ${step.name.padEnd(22)} — ${ran}`);
  }
  lines.push('', `State file: ${STATE_FILE}`);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(lines.join('\n'));
}).listen(3456);

// ── banner ────────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════╗');
console.log('║         career-ops cloud daemon              ║');
console.log('╠══════════════════════════════════════════════╣');
for (const s of STEPS) {
  const t = `${String(s.utcH).padStart(2,'0')}:${String(s.utcM).padStart(2,'0')} UTC`;
  console.log(`║  ${t}  Step ${s.id}: ${s.name.padEnd(24)}║`);
}
console.log('╠══════════════════════════════════════════════╣');
console.log('║  Status: curl http://localhost:3456           ║');
console.log('╚══════════════════════════════════════════════╝');
