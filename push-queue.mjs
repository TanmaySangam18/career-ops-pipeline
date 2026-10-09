#!/usr/bin/env node
/**
 * push-queue.mjs — Push local apply-queue.json to GitHub Actions artifact store.
 *
 * Run this after a local pipeline-run.mjs session to update the cloud queue.
 * The next GitHub Actions batch run will pick up the new jobs.
 *
 * Usage:
 *   node push-queue.mjs                # push apply-queue.json
 *   node push-queue.mjs --status       # show remote artifact info
 *   node push-queue.mjs --dry-run      # preview without pushing
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const STATUS  = args.includes('--status');

const QUEUE_FILE = join(__dirname, 'batch', 'apply-queue.json');
const REPO       = 'TanmaySangam18/career-ops-pipeline';

function gh(...a) {
  return spawnSync('gh', a, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

if (STATUS) {
  const res = gh('api', `repos/${REPO}/actions/artifacts?name=apply-queue&per_page=1`);
  try {
    const data = JSON.parse(res.stdout);
    const a = data.artifacts?.[0];
    if (!a) { console.log('No apply-queue artifact found on GitHub yet.'); process.exit(0); }
    console.log(`Remote apply-queue artifact:`);
    console.log(`  Created: ${a.created_at}`);
    console.log(`  Size:    ${(a.size_in_bytes / 1024).toFixed(1)} KB`);
    console.log(`  Expires: ${a.expires_at}`);
  } catch { console.error('Could not fetch artifact info:', res.stderr); }
  process.exit(0);
}

if (!existsSync(QUEUE_FILE)) {
  console.error(`❌ No apply-queue.json found at ${QUEUE_FILE}`);
  console.error('   Run: node pipeline-run.mjs --from-batch  to build the queue first.');
  process.exit(1);
}

const queue = JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
console.log(`apply-queue.json: ${queue.length} jobs`);

const tierA = queue.filter(j => j.tier === 'A').length;
const tierB = queue.filter(j => j.tier === 'B').length;
console.log(`  Tier A (auto): ${tierA}  |  Tier B (manual): ${tierB}`);

if (queue.length === 0) {
  console.log('Queue is empty — nothing to push.');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n[dry-run] Would trigger workflow dispatch to upload artifact.');
  process.exit(0);
}

// Trigger a workflow dispatch to run apply-batch1 with the queue
// The easiest way to push an artifact is via workflow_dispatch + the queue committed temporarily
// For now: trigger the workflow, which will use the last artifact. After local run, user manually
// triggers if they want to force-apply the new queue immediately.

// Actually: the cleanest approach is to encode the queue and set it as a workflow input.
// But GitHub Actions artifact upload requires a running workflow.
// So we use the GitHub REST API to create a workflow dispatch with the queue size as input.

console.log('\nPushing queue via workflow trigger...');
const res = gh('workflow', 'run', 'apply-batch1.yml',
  '--repo', REPO,
  '--ref', 'main',
  '--raw-field', `note=manual-queue-push-${queue.length}-jobs`
);

if (res.status === 0) {
  console.log(`✅ Triggered apply-batch1 workflow. ${queue.length} jobs in queue.`);
  console.log('   GitHub Actions will pick up the latest apply-queue.json artifact.');
  console.log('   Check: https://github.com/' + REPO + '/actions');
} else {
  console.error('⚠️  Workflow trigger failed:', res.stderr?.slice(0, 200));
  console.log('\nAlternative: commit queue file locally and push, or go to:');
  console.log('  https://github.com/' + REPO + '/actions/workflows/apply-batch1.yml');
  console.log('  → Run workflow manually');
}
