#!/usr/bin/env node
/**
 * apply-batch-v2.mjs — High-volume batch application engine
 *
 * Reads batch/apply-queue.json (built by pipeline-run.mjs).
 *
 * Tier A (autoSubmit: true,  score 3.0–3.9): fills form → auto-submits
 * Tier B (autoSubmit: false, score 4.0+):    fills form → pauses for review
 *
 * Adapters: Greenhouse · Lever · Ashby · Workday (fill-only) · Generic
 *
 * Realistic throughput:
 *   Greenhouse/Lever/Ashby Tier A: ~2 min/app → 120–150/8-hr day
 *   Mixed platforms:               ~3 min/app → 80–120/8-hr day
 *   Workday always pauses (too complex for reliable auto-submit)
 *
 * Usage:
 *   node apply-batch-v2.mjs --queue batch/apply-queue.json
 *   node apply-batch-v2.mjs --queue batch/apply-queue.json --start 10
 *   node apply-batch-v2.mjs --queue batch/apply-queue.json --platform greenhouse
 *   node apply-batch-v2.mjs --queue batch/apply-queue.json --tier-a-only
 *   node apply-batch-v2.mjs --queue batch/apply-queue.json --dry-run
 *   node apply-batch-v2.mjs --queue batch/apply-queue.json --headless --concurrency 3
 */

import { chromium }                              from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve, basename }      from 'path';
import { fileURLToPath }                          from 'url';
import { load as yamlLoad }                       from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args      = process.argv.slice(2);

// ── Flags ─────────────────────────────────────────────────────────────────────
const QUEUE_FILE     = (args.find(a => a.startsWith('--queue='))?.split('=')[1])
                     ?? (args[args.indexOf('--queue') + 1])
                     ?? join(__dirname, 'batch', 'apply-queue.json');
const DRY_RUN        = args.includes('--dry-run');
const TIER_A_ONLY    = args.includes('--tier-a-only');
const TIER_B_ONLY    = args.includes('--tier-b-only');
const HEADLESS       = args.includes('--headless') || process.env.CAREER_OPS_HEADLESS === 'true';
const CONCURRENCY    = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]
                     ?? process.env.CAREER_OPS_CONCURRENCY ?? '1');
const PLATFORM_ONLY  = args.find(a => a.startsWith('--platform='))?.split('=')[1] ?? null;
const START_AT       = parseInt(args.find(a => a.startsWith('--start='))?.split('=')[1] ?? '0');
const PAUSE_MS       = 300_000; // 5 min per Tier B form before timing out
const SCREENSHOTS    = join(__dirname, 'batch', 'screenshots');

if (!existsSync(SCREENSHOTS)) mkdirSync(SCREENSHOTS, { recursive: true });

// ── Profile ───────────────────────────────────────────────────────────────────
const profile = yamlLoad(readFileSync(join(__dirname, 'config', 'profile.yml'), 'utf8'));
const c       = profile.candidate;
const ME = {
  firstName:   c.full_name.split(' ')[0],
  lastName:    c.full_name.split(' ').slice(1).join(' '),
  fullName:    c.full_name,
  email:       c.email,
  phone:       c.phone ?? '6179875458',
  linkedin:    `https://${c.linkedin}`,
  portfolio:   c.portfolio_url,
  github:      c.github ?? '',
  location:    'Boston, MA',
  workAuth:    'Yes',
  sponsorship: 'No',
  salary:      '120000',
  salaryText:  '$120,000',
};

// ── Queue ─────────────────────────────────────────────────────────────────────
if (!existsSync(QUEUE_FILE)) {
  console.error(`❌ Queue not found: ${QUEUE_FILE}\n   Run pipeline-run.mjs first.`);
  process.exit(1);
}
const rawQueue = JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
let queue = rawQueue.slice(START_AT);
if (TIER_A_ONLY)   queue = queue.filter(j => j.tier === 'A');
if (TIER_B_ONLY)   queue = queue.filter(j => j.tier === 'B');
if (PLATFORM_ONLY) queue = queue.filter(j => j.platform === PLATFORM_ONLY);

const tierA = queue.filter(j => j.autoSubmit);
const tierB = queue.filter(j => !j.autoSubmit);

console.log('\n' + '═'.repeat(60));
console.log('🚀  apply-batch-v2  —  High-Volume Apply Engine');
console.log('═'.repeat(60));
console.log(`   Queue:     ${QUEUE_FILE}`);
console.log(`   Total:     ${queue.length}  (Tier A: ${tierA.length}  Tier B: ${tierB.length})`);
if (PLATFORM_ONLY) console.log(`   Platform filter: ${PLATFORM_ONLY}`);
console.log(`   Mode:      ${DRY_RUN ? 'DRY RUN (no browser)' : 'LIVE'}`);
console.log('═'.repeat(60) + '\n');

if (DRY_RUN) {
  queue.forEach((j, i) => {
    const auto = j.autoSubmit ? '⚡ auto-submit' : '👀 manual review';
    console.log(`  [${i+1}/${queue.length}] ${j.tier} | ${j.score} | ${j.platform.padEnd(10)} | ${auto} | ${j.company} — ${j.role}`);
    console.log(`         ${j.url}`);
    console.log(`         CV: ${basename(j.cv)}`);
  });
  console.log('\nDry run complete. Remove --dry-run to execute.\n');
  process.exit(0);
}

// ── Result log ────────────────────────────────────────────────────────────────
const runId   = new Date().toISOString().replace(/[:.]/g, '-');
const runLog  = join(__dirname, 'batch', `run-${runId}.json`);
const results = [];

function saveLog() {
  const summary = {
    total:     results.length,
    submitted: results.filter(r => r.status === 'submitted').length,
    filled:    results.filter(r => r.status === 'filled').length,
    errors:    results.filter(r => r.status === 'error').length,
    skipped:   results.filter(r => r.status === 'skipped').length,
  };
  writeFileSync(runLog, JSON.stringify({ runId, summary, results }, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sep(n) { console.log('─'.repeat(n ?? 60)); }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30); }
function screenshotPath(company, suffix) {
  return join(SCREENSHOTS, `${runId.slice(0,16)}-${slug(company)}-${suffix}.png`);
}

async function acceptCookies(pg) {
  for (const sel of [
    'button:has-text("Accept All")', 'button:has-text("Accept all")',
    'button:has-text("I Accept")',   'button:has-text("Agree")',
    'button:has-text("OK")',         '[id*="accept-cookies"]',
  ]) {
    const btn = pg.locator(sel).first();
    if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await pg.waitForTimeout(500);
      return;
    }
  }
}

async function uploadCV(pg, cvPath) {
  if (!cvPath || !existsSync(cvPath)) return false;
  const inputs = await pg.$$('input[type="file"]');
  for (const fi of inputs) {
    const accept = await fi.getAttribute('accept').catch(() => '') ?? '';
    if (!accept || /pdf|doc|\*/i.test(accept)) {
      try {
        await fi.setInputFiles(cvPath);
      } catch {
        await fi.evaluate(el => { el.style.cssText = 'display:block;opacity:1;visibility:visible'; });
        await fi.setInputFiles(cvPath).catch(() => {});
      }
      await pg.waitForTimeout(1200);
      return true;
    }
  }
  return false;
}

async function tryFill(pg, selector, value) {
  try {
    const el = pg.locator(selector).first();
    if (await el.count() && await el.isVisible({ timeout: 800 })) {
      await el.fill(String(value));
      return true;
    }
  } catch {}
  return false;
}

async function trySelect(pg, selector, value) {
  try {
    const el = pg.locator(selector).first();
    if (await el.count() && await el.isVisible({ timeout: 800 })) {
      const opts = await el.$$('option');
      for (const opt of opts) {
        const txt = (await opt.textContent() ?? '').trim();
        if (txt.toLowerCase().includes(value.toLowerCase())) {
          await el.selectOption({ label: txt });
          return true;
        }
      }
      await el.selectOption({ index: 1 }).catch(() => {});
      return true;
    }
  } catch {}
  return false;
}

async function clickSubmit(pg) {
  const candidates = [
    '#submit_app',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit Application")',
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
    '[data-qa="btn-submit"]',
    '.submit-btn',
  ];
  for (const sel of candidates) {
    const btn = pg.locator(sel).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click();
      return true;
    }
  }
  return false;
}

// Wait for a success signal after submission
async function waitForConfirmation(pg, timeout = 20_000) {
  try {
    // Greenhouse: redirects to /confirmation or shows success header
    await Promise.race([
      pg.waitForURL(/confirmation|success|thank.?you|submitted/i, { timeout }),
      pg.waitForSelector('h1:has-text("Application submitted"), .success-message, [class*="confirmation"]', { timeout }),
    ]);
    return true;
  } catch {
    return false;
  }
}

// ── ATS Adapters ──────────────────────────────────────────────────────────────

async function fillGreenhouse(pg, job) {
  console.log('   Adapter: Greenhouse');
  // Wait for form
  await pg.waitForSelector('form#application_form, form.application-form, form[action*="greenhouse"]', { timeout: 12000 }).catch(() => {});

  // Name
  await tryFill(pg, '#first_name, input[name="job_application[first_name]"]', ME.firstName);
  await tryFill(pg, '#last_name, input[name="job_application[last_name]"]', ME.lastName);
  // Some Greenhouse forms use a single name field
  if (!(await tryFill(pg, '#first_name', ME.firstName))) {
    await tryFill(pg, 'input[placeholder*="First name"], input[aria-label*="First name"]', ME.firstName);
  }

  // Email & phone
  await tryFill(pg, '#email, input[name="job_application[email]"], input[type="email"]', ME.email);
  await tryFill(pg, '#phone, input[name="job_application[phone]"], input[type="tel"]', ME.phone);

  // Location
  await tryFill(pg, '#job_application_location, input[name*="location"], input[placeholder*="City, State"]', ME.location);

  // LinkedIn / Portfolio
  await tryFill(pg, 'input[name*="linkedin"], input[id*="linkedin"], input[placeholder*="LinkedIn"]', ME.linkedin);
  await tryFill(pg, 'input[name*="website"], input[name*="portfolio"], input[placeholder*="website"]', ME.portfolio);

  // Resume upload
  const uploaded = await uploadCV(pg, job.cv);
  if (uploaded) console.log(`   ✅ CV uploaded`);

  // Cover letter
  if (job.cover) {
    // Greenhouse cover letter fields
    const clFilled = await tryFill(pg,
      '#cover_letter_text, textarea[name="job_application[cover_letter]"], textarea[placeholder*="cover"]',
      job.cover
    );
    if (clFilled) console.log('   ✅ Cover letter filled');
  }

  // Work auth radios — look for "Yes" on authorization questions
  const radios = await pg.$$('input[type="radio"]');
  for (const r of radios) {
    const name  = await r.getAttribute('name').catch(() => '') ?? '';
    const val   = (await r.getAttribute('value').catch(() => '') ?? '').toLowerCase();
    const label = await r.evaluate(el => {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      return lbl?.textContent?.trim() ?? el.closest('label')?.textContent?.trim() ?? '';
    }).catch(() => '');
    const combined = (name + ' ' + val + ' ' + label).toLowerCase();

    if (/authorized|work.?auth|legally.?authorized/.test(combined) && /yes/.test(val)) {
      await r.check().catch(() => {});
    }
    if (/sponsor|require.?sponsor/.test(combined) && /no/.test(val)) {
      await r.check().catch(() => {});
    }
  }

  // EEOC / voluntary disclosures — skip (don't fill demographics)
  // How did you hear — LinkedIn
  await trySelect(pg, 'select[id*="how_did"], select[name*="how_did"], select[id*="source"]', 'LinkedIn');
  await tryFill(pg, 'input[id*="how_did"], input[name*="how_did"]', 'LinkedIn');

  await pg.waitForTimeout(800);
}

async function fillLever(pg, job) {
  console.log('   Adapter: Lever');
  await pg.waitForSelector('input[name="name"], input[type="email"]', { timeout: 12000 }).catch(() => {});

  // Full name or first/last
  const hasSplit = await pg.locator('input[name="first_name"]').count();
  if (hasSplit) {
    await tryFill(pg, 'input[name="first_name"], input[placeholder*="First"]', ME.firstName);
    await tryFill(pg, 'input[name="last_name"],  input[placeholder*="Last"]',  ME.lastName);
  } else {
    await tryFill(pg, 'input[name="name"], input[placeholder*="full name"], input[placeholder*="Full name"]', ME.fullName);
  }

  await tryFill(pg, 'input[name="email"], input[type="email"]', ME.email);
  await tryFill(pg, 'input[name="phone"], input[type="tel"]',   ME.phone);
  await tryFill(pg, 'input[name="urls[LinkedIn]"], input[placeholder*="LinkedIn"]', ME.linkedin);
  await tryFill(pg, 'input[name="urls[Other]"], input[placeholder*="website"], input[placeholder*="portfolio"]', ME.portfolio);

  const uploaded = await uploadCV(pg, job.cv);
  if (uploaded) console.log('   ✅ CV uploaded');

  if (job.cover) {
    const ok = await tryFill(pg, 'textarea[name="comments"], textarea[placeholder*="cover"], textarea[name*="additional"]', job.cover);
    if (ok) console.log('   ✅ Cover letter filled');
  }

  await trySelect(pg, 'select[name*="how"], select[name*="source"]', 'LinkedIn');
  await tryFill(pg, 'input[name*="how"], input[placeholder*="How did"]', 'LinkedIn');
  await pg.waitForTimeout(800);
}

async function fillAshby(pg, job) {
  console.log('   Adapter: Ashby');
  await pg.waitForSelector('input[type="text"], input[type="email"]', { timeout: 12000 }).catch(() => {});

  await tryFill(pg, 'input[name*="firstName"], input[placeholder*="First name"], input[aria-label*="First name"]', ME.firstName);
  await tryFill(pg, 'input[name*="lastName"],  input[placeholder*="Last name"],  input[aria-label*="Last name"]',  ME.lastName);
  await tryFill(pg, 'input[type="email"]', ME.email);
  await tryFill(pg, 'input[type="tel"]',  ME.phone);
  await tryFill(pg, 'input[placeholder*="LinkedIn"], input[aria-label*="LinkedIn"]', ME.linkedin);
  await tryFill(pg, 'input[placeholder*="website"], input[placeholder*="portfolio"], input[placeholder*="Website"]', ME.portfolio);

  const uploaded = await uploadCV(pg, job.cv);
  if (uploaded) console.log('   ✅ CV uploaded');

  if (job.cover) {
    const ok = await tryFill(pg, 'textarea', job.cover);
    if (ok) console.log('   ✅ Cover letter filled');
  }

  await pg.waitForTimeout(800);
}

async function fillWorkday(pg, job) {
  // Workday is multi-step and session-based — fill what's visible, pause for user
  console.log('   Adapter: Workday (fill-and-pause — multi-step form)');
  await pg.waitForTimeout(3000);

  // Try to upload resume first (Workday often prompts for this on step 1)
  const uploaded = await uploadCV(pg, job.cv);
  if (uploaded) console.log('   ✅ CV uploaded');

  // Fill any visible text fields using generic logic
  const inputs = await pg.$$('input[type="text"],input[type="email"],input[type="tel"]');
  for (const el of inputs) {
    if (!await el.isVisible().catch(() => false)) continue;
    const ph = await el.getAttribute('placeholder').catch(() => '') ?? '';
    const nm = await el.getAttribute('name').catch(() => '') ?? '';
    const combined = (ph + ' ' + nm).toLowerCase();

    if (/first.?name/i.test(combined)) await el.fill(ME.firstName).catch(() => {});
    else if (/last.?name/i.test(combined)) await el.fill(ME.lastName).catch(() => {});
    else if (/email/i.test(combined))      await el.fill(ME.email).catch(() => {});
    else if (/phone|mobile/i.test(combined)) await el.fill(ME.phone).catch(() => {});
  }

  console.log('   ⚠️  Workday is multi-step — auto-submit disabled. Review and submit manually.');
  // Force manual review for Workday regardless of tier
  return 'workday-pause';
}

// Generic fallback using apply-job.mjs logic
async function fillGeneric(pg, job) {
  console.log('   Adapter: Generic');

  const SKIP  = [/relative|family.?member/i, /referr(al|ed)|who.?referred/i, /clearance/i, /additional.?info|anything.?else/i];
  const RULES = [
    { pat: /first.?name/i,                              val: ME.firstName },
    { pat: /last.?name/i,                               val: ME.lastName },
    { pat: /\bname\b|full.?name/i,                      val: ME.fullName },
    { pat: /email/i,                                    val: ME.email },
    { pat: /phone|mobile/i,                             val: ME.phone },
    { pat: /location|city/i,                            val: ME.location },
    { pat: /linkedin/i,                                 val: ME.linkedin },
    { pat: /github/i,                                   val: ME.github },
    { pat: /portfolio|personal.?site|website/i,         val: ME.portfolio },
    { pat: /salary|compensation/i,                      val: ME.salaryText },
    { pat: /authorized|work.?auth/i,                    val: ME.workAuth },
    { pat: /sponsor/i,                                  val: ME.sponsorship },
    { pat: /how.?did.?you.?hear/i,                      val: 'LinkedIn' },
    { pat: /cover.?letter/i,                            val: job.cover ?? '' },
  ];

  async function getHint(el) {
    const id   = await el.getAttribute('id').catch(() => '') ?? '';
    const aria = await el.getAttribute('aria-label').catch(() => '') ?? '';
    const ph   = await el.getAttribute('placeholder').catch(() => '') ?? '';
    const nm   = await el.getAttribute('name').catch(() => '') ?? '';
    let lbl    = '';
    if (id) {
      const lblEl = await pg.$(`label[for="${id}"]`).catch(() => null);
      if (lblEl) lbl = await lblEl.textContent().catch(() => '') ?? '';
    }
    if (!lbl) {
      lbl = await el.evaluate(node => {
        let p = node.parentElement;
        for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
          if (p.tagName === 'LABEL') return p.textContent ?? '';
          const prev = p.previousElementSibling;
          if (prev?.textContent?.trim()?.length < 80) return prev.textContent.trim();
        }
        return '';
      }).catch(() => '');
    }
    return [lbl, aria, ph, nm].filter(Boolean).join(' ').trim();
  }

  const inputs = await pg.$$('input[type="text"],input[type="email"],input[type="tel"],input[type="url"],input:not([type]),textarea');
  let filled = 0;
  for (const el of inputs) {
    if (!await el.isVisible().catch(() => false)) continue;
    const hint = await getHint(el);
    if (SKIP.some(p => p.test(hint))) continue;
    for (const r of RULES) {
      if (r.pat.test(hint) && r.val) {
        await el.fill(r.val).catch(() => {});
        filled++;
        break;
      }
    }
  }
  console.log(`   ✅ ${filled} fields filled`);

  const uploaded = await uploadCV(pg, job.cv);
  if (uploaded) console.log('   ✅ CV uploaded');

  await pg.waitForTimeout(800);
}

// ── Navigate to application form ──────────────────────────────────────────────
async function navigateToForm(context, job) {
  const pg = await context.newPage();
  let url   = job.url;

  console.log(`   Navigating → ${url}`);
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pg.waitForTimeout(2000);
  await acceptCookies(pg);

  const currentUrl = pg.url();

  // If already on an apply form, good
  if (/\/apply\b|\/application\b|ashby\.com|greenhouse\.io|lever\.co/i.test(currentUrl)) {
    return pg;
  }

  // Look for an Apply button to click through
  const applySelectors = [
    'a[href*="/apply"]',
    'button:has-text("Apply")',
    'a:has-text("Apply now")',
    'a:has-text("Apply for this job")',
    'a:has-text("Apply on company website")',
    '[data-qa="btn-apply"]',
  ];
  for (const sel of applySelectors) {
    const btn = pg.locator(sel).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      const newTabPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await btn.click().catch(() => {});
      const newTab = await newTabPromise;
      if (newTab) {
        await newTab.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        await pg.close().catch(() => {});
        await acceptCookies(newTab);
        return newTab;
      }
      await pg.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      break;
    }
  }

  return pg;
}

// ── Worker: process one job in a given browser ───────────────────────────────
async function processJob(browser, job, index, total) {
  sep();
  console.log(`\n[${index}/${total}] ${job.tier === 'A' ? '⚡' : '👀'}  ${job.company} — ${job.role}`);
  console.log(`   Score: ${job.score}  |  Platform: ${job.platform}  |  Tier: ${job.tier} (${job.autoSubmit ? 'auto-submit' : 'manual review'})`);
  console.log(`   URL: ${job.url}`);
  console.log(`   CV:  ${basename(job.cv ?? '')}`);

  const result = {
    index, company: job.company, role: job.role, score: job.score,
    url: job.url, platform: job.platform, tier: job.tier,
    autoSubmit: job.autoSubmit, status: 'error', error: null,
    timestamp: new Date().toISOString(),
  };

  const context = await browser.newContext({ viewport: null, acceptDownloads: true });
  try {
    const pg = await navigateToForm(context, job);
    await pg.waitForTimeout(1000);
    await pg.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await pg.waitForTimeout(800);
    await pg.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await pg.waitForTimeout(500);

    if (!HEADLESS) await pg.screenshot({ path: screenshotPath(job.company, '1-before'), fullPage: true }).catch(() => {});

    let adapterResult = null;
    const platform = job.platform ?? 'generic';
    if (/greenhouse/i.test(platform))   await fillGreenhouse(pg, job);
    else if (/lever/i.test(platform))   await fillLever(pg, job);
    else if (/ashby/i.test(platform))   await fillAshby(pg, job);
    else if (/workday/i.test(platform)) adapterResult = await fillWorkday(pg, job);
    else                                await fillGeneric(pg, job);

    if (!HEADLESS) await pg.screenshot({ path: screenshotPath(job.company, '2-filled'), fullPage: true }).catch(() => {});

    const forceManual = adapterResult === 'workday-pause' || (HEADLESS && !job.autoSubmit);

    if (job.autoSubmit && !forceManual) {
      console.log('\n   ⚡ Tier A — submitting...');
      const clicked = await clickSubmit(pg);
      if (clicked) {
        const confirmed = await waitForConfirmation(pg);
        console.log(confirmed
          ? `   ✅ SUBMITTED — ${job.company}`
          : `   ⚠️  Submitted (no confirmation page) — ${job.company}`);
        if (!HEADLESS) await pg.screenshot({ path: screenshotPath(job.company, '3-confirmed'), fullPage: true }).catch(() => {});
        result.status = 'submitted';
      } else {
        console.log('   ⚠️  Submit button not found — skipping.');
        result.status = 'filled';
      }
    } else if (!HEADLESS) {
      console.log('\n   👀 Tier B — form filled. Review and submit manually.');
      console.log('   ⏳ Waiting up to 5 min for you to submit...');
      try {
        await pg.waitForURL(
          url => !/\/apply\b/i.test(url.toString()) || /confirmation|success|thank.?you/i.test(url.toString()),
          { timeout: PAUSE_MS }
        );
        console.log('   ✅ Submitted (URL changed) — moving on.');
        result.status = 'submitted';
      } catch {
        console.log('   ⏱  Timed out — marking as filled, continuing.');
        result.status = 'filled';
      }
    } else {
      // Headless + Tier B: can't pause — mark filled for manual follow-up
      result.status = 'filled';
    }
  } catch (err) {
    console.log(`\n   ❌ Error: ${err.message}`);
    result.status = 'error';
    result.error  = err.message;
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

// ── Main loop — concurrent workers ───────────────────────────────────────────
const launchArgs = HEADLESS
  ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  : ['--start-maximized'];

const browser = await chromium.launch({
  headless: HEADLESS,
  channel:  HEADLESS ? undefined : 'chrome',
  slowMo:   HEADLESS ? 20 : 40,
  args:     launchArgs,
});

if (HEADLESS) console.log('   Mode: headless (cloud)');
if (CONCURRENCY > 1) console.log(`   Concurrency: ${CONCURRENCY} parallel workers`);

let submitted = 0, filled = 0, errors = 0;

// Split queue into CONCURRENCY chunks and process in parallel
const chunkSize = Math.ceil(queue.length / CONCURRENCY);
const chunks    = Array.from({ length: CONCURRENCY }, (_, i) => queue.slice(i * chunkSize, (i + 1) * chunkSize));

// Process each chunk sequentially within itself; chunks run in parallel
const allResults = await Promise.all(chunks.map(async (chunk, workerIdx) => {
  const workerResults = [];
  for (let i = 0; i < chunk.length; i++) {
    const globalIdx = workerIdx * chunkSize + i + 1;
    const res = await processJob(browser, chunk[i], globalIdx, queue.length);
    workerResults.push(res);
    results.push(res);
    saveLog();
    if (res.status === 'submitted') submitted++;
    else if (res.status === 'filled') filled++;
    else errors++;
    if (i < chunk.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  return workerResults;
}));

await browser.close();

// ── Final summary ─────────────────────────────────────────────────────────────
sep();
console.log('\n📊 Run complete:\n');
console.log(`   ✅ Submitted:    ${submitted}`);
console.log(`   📋 Filled:       ${filled}  (browser closed before submit)`);
console.log(`   ❌ Errors:       ${errors}`);
console.log(`   📁 Run log:      ${runLog}`);
console.log(`   📸 Screenshots:  ${SCREENSHOTS}\n`);
console.log('Post-run steps:');
console.log('   node merge-tracker.mjs        → sync applied roles to tracker');
console.log('   node network-lookup.mjs       → check LinkedIn connections\n');
sep();
