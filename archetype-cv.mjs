import { readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const OUTPUT_DIR = resolve('/Users/durgasaitanmaysangam/career-ops/output');

const ARCHETYPES = {
  PM: ['product', 'roadmap', 'sprint', 'agile', 'user story', 'stakeholder', 'okr', 'kpi',
    'product manager', 'apm', 'product lead', 'launch', 'feature', 'backlog', 'prd', 'spec',
    'go-to-market', 'product strategy', 'user research', 'a/b test', 'adoption', 'retention'],
  BA: ['analysis', 'data', 'sql', 'excel', 'dashboard', 'reporting', 'business analyst',
    'requirements', 'process mapping', 'insights', 'tableau', 'power bi', 'looker', 'metrics',
    'data-driven', 'visualization', 'model', 'forecast'],
  OPS: ['operations', 'process', 'coordination', 'cross-functional', 'program manager',
    'logistics', 'vendor', 'workflow', 'execution', 'chief of staff', "founder's associate",
    'bizops', 'business operations', 'strategy', 'planning', 'program', 'project coordinator'],
  GTM: ['revenue', 'pipeline', 'crm', 'sales', 'marketing', 'go-to-market', 'customer success',
    'partnerships', 'account manager', 'revops', 'gtm', 'enablement', 'playbook', 'funnel',
    'conversion', 'churn', 'arr', 'mrr', 'onboarding'],
  CS: ['customer success', 'implementation', 'onboarding', 'client', 'support',
    'account management', 'customer', 'satisfaction', 'nps', 'csat', 'sla',
    'escalation', 'renewal', 'upsell'],
};

const ARCHETYPE_FILE_HINTS = {
  PM: ['pm', 'product'],
  BA: ['ba', 'analyst', 'data'],
  OPS: ['ops', 'operations', 'program'],
  GTM: ['gtm', 'sales', 'revenue', 'marketing'],
  CS: ['cs', 'customer', 'support'],
};

export function detectArchetype(title, jdText) {
  const corpus = (title + ' ' + jdText).toLowerCase();
  const scores = {};
  for (const [archetype, keywords] of Object.entries(ARCHETYPES)) {
    let hits = 0;
    for (const kw of keywords) {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = corpus.match(re);
      if (matches) hits += matches.length;
    }
    scores[archetype] = hits / keywords.length;
  }
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

function getPdfs() {
  try {
    return readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('.pdf'))
      .map(f => ({ name: f.toLowerCase(), path: join(OUTPUT_DIR, f), mtime: statSync(join(OUTPUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export function pickCV(title, jdText) {
  const archetype = detectArchetype(title, jdText);
  const pdfs = getPdfs();
  if (!pdfs.length) return null;

  const hints = ARCHETYPE_FILE_HINTS[archetype];
  const cvFiles = pdfs.filter(f => f.name.includes('cv') && !f.name.includes('cover'));

  for (const hint of hints) {
    const match = cvFiles.find(f => f.name.includes(hint));
    if (match) return match.path;
  }

  const anyMatch = cvFiles.find(f => hints.some(h => f.name.includes(h)));
  if (anyMatch) return anyMatch.path;

  return (cvFiles[0] ?? pdfs[0]).path;
}

export default pickCV;

if (process.argv[1]?.includes('archetype-cv')) {
  const args = process.argv.slice(2);
  const titleIdx = args.indexOf('--title');
  const jdIdx = args.indexOf('--jd');
  const title = titleIdx !== -1 ? args[titleIdx + 1] : '';
  let jd = jdIdx !== -1 ? args[jdIdx + 1] : '';

  if (jd && !jd.includes(' ')) {
    try { jd = (await import('fs')).readFileSync(jd, 'utf8'); } catch {}
  }

  const archetype = detectArchetype(title, jd);
  const cv = pickCV(title, jd);
  process.stdout.write(`Archetype: ${archetype}\nCV: ${cv}\n`);
}
