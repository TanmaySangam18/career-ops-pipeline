import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { load as yamlLoad } from 'js-yaml';
import { pickCV } from './archetype-cv.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SESSION_FILE = join(__dirname, 'batch', 'linkedin-session.json');
const RESULTS_FILE = join(__dirname, 'batch', `linkedin-run-${timestamp}.json`);
const DEFAULT_CV   = join(__dirname, 'output', 'tanmay-sangam-tesla-pm-sales-delivery.pdf');
const BATCH_DIR    = join(__dirname, 'batch');

const SEARCHES = [
  { keywords: 'Product Manager',              location: 'United States' },
  { keywords: 'Associate Product Manager',    location: 'United States' },
  { keywords: 'Business Analyst',             location: 'United States' },
  { keywords: 'Strategy Operations Associate',location: 'United States' },
  { keywords: 'Program Manager',              location: 'United States' },
  { keywords: 'Chief of Staff',               location: 'United States' },
  { keywords: 'Business Operations Associate',location: 'United States' },
  { keywords: 'Founder Associate',            location: 'United States' },
  { keywords: 'GTM Operations',               location: 'United States' },
  { keywords: 'Revenue Operations',           location: 'United States' },
  { keywords: 'Customer Success Manager',     location: 'United States' },
  { keywords: 'Implementation Manager',       location: 'United States' },
  { keywords: 'Project Manager',              location: 'United States' },
  { keywords: 'Operations Coordinator',       location: 'United States' },
  { keywords: 'Product Operations',           location: 'United States' },
];

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const flagVal = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

const SAVE_SESSION = flag('--save-session');
const DRY_RUN      = flag('--dry-run');
const HEADLESS     = flag('--headless');
const MAX_APPS     = parseInt(flagVal('--max') || '100', 10);
const OVERRIDE_KW  = flagVal('--search');
const OVERRIDE_LOC = flagVal('--location');

if (!existsSync(BATCH_DIR)) mkdirSync(BATCH_DIR, { recursive: true });

const profile = yamlLoad(readFileSync(join(__dirname, 'config', 'profile.yml'), 'utf8'));
const c = profile.candidate;
const ME = {
  firstName:   c.full_name?.split(' ')[0] ?? 'Tanmay',
  lastName:    c.full_name?.split(' ').slice(1).join(' ') ?? 'Sangam',
  email:       c.email ?? '',
  phone:       c.phone ?? '',
  linkedin:    c.linkedin ?? '',
  location:    c.location ?? 'Boston, MA',
  workAuth:    'Yes',
  sponsorship: 'No',
  salary:      '120000',
  yearsExp:    '4',
};

function buildSearchUrl(keywords, location) {
  const p = new URLSearchParams({
    keywords, location,
    f_AL: 'true',
    f_WT: '2',
    sortBy: 'DD',
  });
  return `https://www.linkedin.com/jobs/search/?${p}`;
}

function loadSession() {
  if (!existsSync(SESSION_FILE)) return { cookies: [], applied: [] };
  return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
}

function saveSession(data) {
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

function extractJobId(url) {
  const m = url.match(/\/jobs\/view\/(\d+)/);
  return m ? m[1] : null;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base = 800, range = 1200) => delay(base + Math.random() * range);

async function saveSessionFlow() {
  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto('https://www.linkedin.com/login');

  console.log('\n─────────────────────────────────────────────────────');
  console.log('LinkedIn browser is open.');
  console.log('⚠️  DO NOT click "Sign in with Google" — it is blocked.');
  console.log('✅  Type your LinkedIn EMAIL + PASSWORD directly, then click Sign In.');
  console.log('Waiting up to 5 minutes for you to log in...');
  console.log('─────────────────────────────────────────────────────\n');

  await pg.waitForURL('**/feed**', { timeout: 300_000 });
  const cookies = await ctx.cookies();
  saveSession({ cookies, applied: [] });
  console.log(`\n✅ Session saved to ${SESSION_FILE}`);
  await browser.close();
}

async function fillTextField(pg, selector, value) {
  try {
    await pg.waitForSelector(selector, { timeout: 3000 });
    await pg.click(selector);
    await pg.fill(selector, '');
    await pg.type(selector, value, { delay: 40 + Math.random() * 40 });
  } catch {}
}

async function handleDropdown(pg, labelPattern, value) {
  const selects = await pg.$$('select');
  for (const sel of selects) {
    const label = await sel.evaluate(el => {
      const id = el.id;
      const lbl = id ? document.querySelector(`label[for="${id}"]`) : null;
      return lbl ? lbl.textContent : '';
    });
    if (labelPattern.test(label)) {
      await sel.selectOption({ label: value }).catch(() => sel.selectOption(value).catch(() => {}));
      return true;
    }
  }
  return false;
}

async function handleRadioQuestion(pg, labelPattern, answer) {
  const fieldsets = await pg.$$('fieldset');
  for (const fs of fieldsets) {
    const legend = await fs.$('legend');
    const text = legend ? await legend.textContent() : '';
    if (labelPattern.test(text)) {
      const radios = await fs.$$('input[type="radio"]');
      for (const r of radios) {
        const rLabel = await r.evaluate(el => {
          const lbl = el.labels?.[0] || document.querySelector(`label[for="${el.id}"]`);
          return lbl ? lbl.textContent.trim() : '';
        });
        if (rLabel.toLowerCase().includes(answer.toLowerCase())) {
          await r.click();
          return true;
        }
      }
    }
  }
  return false;
}

async function fillModalStep(pg, cvPath) {
  await jitter(400, 600);

  // Phone
  await fillTextField(pg, 'input[id*="phoneNumber"]', ME.phone);

  // Work auth radio
  await handleRadioQuestion(pg, /authorized|work.?auth/i, 'Yes');

  // Sponsorship radio
  await handleRadioQuestion(pg, /sponsor/i, 'No');
  await handleDropdown(pg, /sponsor/i, 'No');

  // Work auth dropdown fallback
  await handleDropdown(pg, /authorized|work.?auth/i, 'Yes');

  // Years of experience text inputs
  const expInputs = await pg.$$('input[id*="yearsOfExperience"], input[id*="years"][type="text"]');
  for (const inp of expInputs) {
    await inp.fill('');
    await inp.type(ME.yearsExp, { delay: 40 });
  }

  // Salary
  await fillTextField(pg, 'input[id*="salary"], input[id*="desiredSalary"]', ME.salary);

  // Location
  await fillTextField(pg, 'input[id*="city"], input[id*="location"]', ME.location);

  // Generic yes/no dropdowns — lean toward "Yes" for auth, "No" for sponsorship
  const allSelects = await pg.$$('select');
  for (const sel of allSelects) {
    const label = await sel.evaluate(el => {
      const id = el.id;
      const lbl = id ? document.querySelector(`label[for="${id}"]`) : null;
      return lbl ? lbl.textContent.toLowerCase() : '';
    });
    if (/sponsor/i.test(label)) {
      await sel.selectOption({ label: 'No' }).catch(() => sel.selectOption('No').catch(() => {}));
    } else if (/authorized|work.?auth/i.test(label)) {
      await sel.selectOption({ label: 'Yes' }).catch(() => sel.selectOption('Yes').catch(() => {}));
    }
  }

  // Resume upload
  const fileInput = await pg.$('input[type="file"]');
  if (fileInput && existsSync(cvPath)) {
    await fileInput.setInputFiles(cvPath).catch(() => {});
  } else {
    const uploadBtn = pg.getByRole('button', { name: /upload resume/i });
    if (await uploadBtn.count() > 0) {
      const [fc] = await Promise.all([
        pg.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null),
        uploadBtn.click(),
      ]);
      if (fc && existsSync(cvPath)) await fc.setFiles(cvPath).catch(() => {});
    }
  }

  await jitter(300, 500);
}

async function advanceModal(pg, cvPath) {
  const maxSteps = 6;
  for (let step = 0; step < maxSteps; step++) {
    await fillModalStep(pg, cvPath);

    const submitBtn = pg.getByRole('button', { name: /submit application/i });
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
      await jitter(1000, 1500);
      return 'submitted';
    }

    const nextBtn = pg.getByRole('button', { name: /continue to next step|review your application/i });
    if (await nextBtn.count() > 0) {
      await nextBtn.click();
      await jitter(800, 1000);
      continue;
    }

    // Modal may have closed or errored
    const modal = await pg.$('[role="dialog"]');
    if (!modal) return 'modal_closed';
  }
  return 'max_steps_exceeded';
}

async function applyToJob(pg, jobUrl, jobId, cvPath) {
  await pg.goto(jobUrl, { waitUntil: 'domcontentloaded' });
  await jitter(1000, 2000);

  // Check already applied
  const appliedText = await pg.$$eval('*', els =>
    els.some(el => /application submitted/i.test(el.textContent))
  ).catch(() => false);
  if (appliedText) return { status: 'already_applied' };

  // Check for Easy Apply button
  const easyApplyBtn = pg.getByRole('button', { name: /easy apply/i });
  if (await easyApplyBtn.count() === 0) return { status: 'easy_apply_not_available' };

  await easyApplyBtn.first().click();
  await jitter(1000, 1500);

  // Detect captcha
  const captcha = await pg.$('iframe[src*="captcha"], #captcha-internal').catch(() => null);
  if (captcha) {
    await pg.screenshot({ path: join(BATCH_DIR, `captcha-${jobId}.png`) });
    await delay(30_000);
    return { status: 'error', error: 'captcha_detected' };
  }

  const outcome = await advanceModal(pg, cvPath).catch(e => ({ err: e.message }));
  if (typeof outcome === 'object') return { status: 'error', error: outcome.err };
  if (outcome === 'submitted') return { status: 'submitted' };
  return { status: 'error', error: outcome };
}

async function scrapeJobListings(pg, searchUrl) {
  await pg.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await jitter(1500, 2000);

  const jobs = [];
  const cards = await pg.$$('.job-card-container, [data-job-id], article[data-job-id]');

  for (const card of cards) {
    try {
      const href = await card.$eval('a[href*="/jobs/view/"]', a => a.href).catch(() => null);
      if (!href) continue;
      const jobId = extractJobId(href);
      if (!jobId) continue;
      const company = await card.$eval('[class*="company"], [class*="subtitle"]', el => el.textContent.trim()).catch(() => '');
      const role    = await card.$eval('[class*="title"] a, h3', el => el.textContent.trim()).catch(() => '');
      jobs.push({ jobId, url: href, company, role });
    } catch {}
  }

  // Fallback: scan all job links in page
  if (jobs.length === 0) {
    const links = await pg.$$eval('a[href*="/jobs/view/"]', anchors =>
      [...new Set(anchors.map(a => a.href))]
    ).catch(() => []);
    for (const url of links) {
      const jobId = extractJobId(url);
      if (jobId) jobs.push({ jobId, url, company: '', role: '' });
    }
  }

  return jobs;
}

async function run() {
  if (SAVE_SESSION) { await saveSessionFlow(); return; }

  const session = loadSession();
  const appliedSet = new Set(session.applied ?? []);
  const results = [];
  let totalSeen = 0, totalApplied = 0, totalSkipped = 0, totalErrors = 0;

  const searchList = (OVERRIDE_KW)
    ? [{ keywords: OVERRIDE_KW, location: OVERRIDE_LOC ?? 'United States' }]
    : SEARCHES;

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: 60 });
  const ctx = await browser.newContext();

  if (session.cookies?.length) {
    await ctx.addCookies(session.cookies);
  }

  const pg = await ctx.newPage();

  // Verify session is alive
  await pg.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (pg.url().includes('/login') || pg.url().includes('/authwall')) {
    console.error('Session expired or not saved. Run with --save-session first.');
    await browser.close();
    process.exit(1);
  }

  let appliedThisRun = 0;
  const RATE_LIMIT = 25;
  const RATE_WINDOW_MS = 60 * 60 * 1000;
  let windowStart = Date.now();

  for (const search of searchList) {
    if (appliedThisRun >= MAX_APPS) break;

    // Pick archetype-matched CV for this search cluster
    const cvPath = pickCV(search.keywords, '') ?? (existsSync(DEFAULT_CV) ? DEFAULT_CV : null);

    const url = buildSearchUrl(search.keywords, search.location);
    console.log(`\nSearch: "${search.keywords}" | ${search.location}`);

    let jobs;
    try {
      jobs = await scrapeJobListings(pg, url);
    } catch (e) {
      console.error(`  Failed to scrape: ${e.message}`);
      continue;
    }

    totalSeen += jobs.length;
    console.log(`  Found ${jobs.length} jobs`);

    for (const job of jobs) {
      if (appliedThisRun >= MAX_APPS) break;

      if (appliedSet.has(job.jobId)) {
        totalSkipped++;
        results.push({ ...job, status: 'skipped', error: null, timestamp: new Date().toISOString() });
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [dry-run] ${job.company} — ${job.role} (${job.jobId})`);
        results.push({ ...job, status: 'dry_run', error: null, timestamp: new Date().toISOString() });
        continue;
      }

      // Rate limit: no more than RATE_LIMIT per hour
      if (appliedThisRun > 0 && appliedThisRun % RATE_LIMIT === 0) {
        const elapsed = Date.now() - windowStart;
        if (elapsed < RATE_WINDOW_MS) {
          const wait = RATE_WINDOW_MS - elapsed + 5000;
          console.log(`  Rate limit: waiting ${Math.round(wait / 60000)}m...`);
          await delay(wait);
        }
        windowStart = Date.now();
      }

      let result;
      try {
        result = await applyToJob(pg, job.url, job.jobId, cvPath);
      } catch (e) {
        result = { status: 'error', error: e.message };
        // Check for session expiry
        if (pg.url().includes('/login') || pg.url().includes('/authwall')) {
          console.error('Session expired mid-run. Stopping.');
          break;
        }
      }

      const entry = { ...job, ...result, timestamp: new Date().toISOString() };
      results.push(entry);

      if (result.status === 'submitted') {
        appliedSet.add(job.jobId);
        appliedThisRun++;
        totalApplied++;
        console.log(`  ✓ Applied: ${job.company} — ${job.role}`);
      } else if (result.status === 'already_applied') {
        totalSkipped++;
        appliedSet.add(job.jobId);
        console.log(`  — Already applied: ${job.company} — ${job.role}`);
      } else if (result.status === 'easy_apply_not_available') {
        totalSkipped++;
      } else {
        totalErrors++;
        console.log(`  ✗ Error (${job.company}): ${result.error ?? result.status}`);
      }

      await jitter(1500, 2500);
    }
  }

  await browser.close();

  // Persist session with updated applied list
  saveSession({ cookies: session.cookies, applied: [...appliedSet] });

  // Write results
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

  // Update apply-queue.json if it exists
  const queueFile = join(BATCH_DIR, 'apply-queue.json');
  if (existsSync(queueFile)) {
    try {
      const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
      const submittedIds = new Set(results.filter(r => r.status === 'submitted').map(r => r.jobId));
      const updated = queue.map(item => {
        const id = extractJobId(item.url ?? '');
        return id && submittedIds.has(id) ? { ...item, status: 'submitted' } : item;
      });
      writeFileSync(queueFile, JSON.stringify(updated, null, 2));
    } catch {}
  }

  console.log(`
═══════════════════════════
LinkedIn Easy Apply — Done
  Searches run:   ${searchList.length}
  Jobs seen:      ${totalSeen}
  Applied:        ${totalApplied}
  Skipped:        ${totalSkipped}  (already applied / not Easy Apply)
  Errors:         ${totalErrors}
  Results:        batch/linkedin-run-${timestamp}.json
═══════════════════════════`);
}

run().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
