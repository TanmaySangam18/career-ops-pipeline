import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';

const SWAPS = [
  [/\bleveraging\b/gi, 'using'],
  [/\bleverage\b/gi, (m, offset, str) => {
    const before = str.slice(0, offset).trimEnd();
    return /[.!?]\s*$/.test(before) || offset === 0 ? 'Put to work' : 'use';
  }],
  [/\butilization\b/gi, 'use'],
  [/\butilize\b/gi, 'use'],
  [/\bdelving\s+into\b/gi, 'looking into'],
  [/\bdelving\b/gi, 'looking at'],
  [/\bdelve\s+into\b/gi, 'dig into'],
  [/\bdelve\b/gi, 'explore'],
  [/\bfostering\b/gi, 'building'],
  [/\bfoster\b/gi, 'build'],
  [/\brobust\b/gi, 'strong'],
  [/\bseamlessly\b/gi, 'smoothly'],
  [/\bseamless\b/gi, 'smooth'],
  [/\bstreamlining\b/gi, 'simplifying'],
  [/\bstreamline\b/gi, 'simplify'],
  [/\bproactively\b/gi, 'early'],
  [/\bproactive\b/gi, 'ahead of the curve'],
  [/\bsynergistic\b/gi, 'complementary'],
  [/\bsynergy\b/gi, ''],
  [/\binnovative\b/gi, ''],
  [/\bdynamic\b/gi, ''],
  [/passionate about/gi, 'focused on'],
  [/I am excited to\b/gi, 'I want to'],
  [/I am pleased to\b/gi, 'I'],
  [/\bIn conclusion[,.]?\s*/gi, ''],
  [/\bTo summarize[,:]?\s*/gi, ''],
  [/\bIt is worth noting that\s*/gi, ''],
  [/\bIt is worth noting\s*/gi, ''],
  [/\bI would like to\b/gi, 'I want to'],
  [/\bFurthermore[,]?\s*/gi, 'And '],
  [/\bMoreover[,]?\s*/gi, 'Also, '],
  [/\bTherefore[,]?\s*/gi, 'So '],
  [/\bThus[,]?\s*/gi, 'So '],
  [/\bConsequently[,]?\s*/gi, 'As a result, '],
  [/\bSubsequently[,]?\s*/gi, 'After that, '],
  [/\bAs a result of this\b/gi, 'Because of this'],
  [/\bIn order to\b/gi, 'To'],
  [/\bDue to the fact that\b/gi, 'Because'],
  [/\bAt this point in time\b/gi, 'Now'],
  [/\bIn the event that\b/gi, 'If'],
  [/\bWith regard to\b/gi, 'About'],
  [/\bIn terms of\b/gi, ''],
  [/\bIt is important to note that\s*/gi, ''],
  [/\bIt is important to note\s*/gi, ''],
  [/\bNeedless to say[,]?\s*/gi, ''],
  [/\bhands-on experience\b/gi, 'experience'],
  [/\bproven track record\b/gi, ''],
  [/\bresults-driven\b/gi, ''],
  [/\bdetail-oriented\b/gi, ''],
  [/\bfast-paced environment\b/gi, ''],
  [/\bteam player\b/gi, ''],
];

const CONTRACTIONS = [
  [/\bdo not\b/g, "don't"],
  [/\bdoes not\b/g, "doesn't"],
  [/\bdid not\b/g, "didn't"],
  [/\bwould not\b/g, "wouldn't"],
  [/\bcould not\b/g, "couldn't"],
  [/\bare not\b/g, "aren't"],
  [/\bis not\b/g, "isn't"],
  [/\bthey are\b/g, "they're"],
  [/\bwe are\b/g, "we're"],
  [/(?<=,\s*)I am\b/g, "I'm"],
  [/^I am\b/gm, "I'm"],
  [/(?<=\.\s+)I am\b/g, "I'm"],
  [/\bthat is\b/g, "that's"],
  [/(?<![A-Z])\bit is\b/g, "it's"],
  [/\bI have\b/g, "I've"],
  [/\bI will\b/g, "I'll"],
];

const CLICHE_CLOSERS = [
  /I look forward to hearing from you[^.]*\./gi,
  /I look forward to the opportunity[^.]*\./gi,
  /Thank you for your consideration[^.]*\./gi,
  /Please do not hesitate to contact me[^.]*\./gi,
  /Please don't hesitate to contact me[^.]*\./gi,
];

function applySwaps(text) {
  for (const [pattern, replacement] of SWAPS) {
    if (typeof replacement === 'function') {
      text = text.replace(pattern, replacement);
    } else {
      text = text.replace(pattern, (m) => {
        if (!replacement) return '';
        const upper = m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase();
        return upper ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
      });
    }
  }
  return text;
}

function applyContractions(text) {
  for (const [pattern, replacement] of CONTRACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function wordCount(sentence) {
  return sentence.trim().split(/\s+/).filter(Boolean).length;
}

function splitLong(sentence) {
  if (wordCount(sentence) <= 35) return sentence;
  const splitters = [', but ', ', and ', ', which ', ', that ', '; '];
  for (const splitter of splitters) {
    const idx = sentence.indexOf(splitter);
    if (idx > 0 && idx < sentence.length - splitter.length) {
      const left = sentence.slice(0, idx).trim();
      const right = sentence.slice(idx + splitter.length).trim();
      const cap = right.charAt(0).toUpperCase() + right.slice(1);
      return `${left}. ${cap}`;
    }
  }
  return sentence;
}

function burstify(text) {
  const paragraphs = text.split(/\n\n+/);
  return paragraphs.map(para => {
    const sentenceRe = /[^.!?]+[.!?]+/g;
    const sentences = para.match(sentenceRe);
    if (!sentences || sentences.length < 3) return para;

    const processed = sentences.map(s => splitLong(s.trim()));

    let hasShort = false;
    for (let i = 0; i < processed.length; i++) {
      if (wordCount(processed[i]) <= 8) { hasShort = true; break; }
    }

    if (!hasShort && processed.length >= 3) {
      const midIdx = Math.floor(processed.length / 2);
      const mid = processed[midIdx];
      const conjIdx = mid.search(/ and | but /i);
      if (conjIdx > 0) {
        const left = mid.slice(0, conjIdx).trim();
        const rightRaw = mid.slice(conjIdx).replace(/^ (and|but) /i, '').trim();
        const right = rightRaw.charAt(0).toUpperCase() + rightRaw.slice(1);
        processed.splice(midIdx, 1, left + '.', right);
      }
    }

    return processed.join(' ');
  }).join('\n\n');
}

function removeClicheClosers(text) {
  for (const pattern of CLICHE_CLOSERS) {
    text = text.replace(pattern, '');
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function cleanArtifacts(text) {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/ ,/g, ',')
    .replace(/ \./g, '.')
    .replace(/\b(in a|in an|within a|within an|as a|as an)\s*\./gi, '.')
    .replace(/\b(in a|in an|within a|within an|as a|as an)\s*,/gi, ',')
    .replace(/\n /g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default function humanize(text) {
  let t = applySwaps(text);
  t = applyContractions(t);
  t = burstify(t);
  t = removeClicheClosers(t);
  t = cleanArtifacts(t);
  return t;
}

export function humanizeFile(inputPath, outputPath) {
  const raw = readFileSync(inputPath, 'utf8');
  const result = humanize(raw);
  writeFileSync(outputPath, result, 'utf8');
  return result;
}

if (process.argv[1]?.includes('humanize')) {
  const fileArg = process.argv[2];
  if (fileArg && fileArg !== '-') {
    const result = humanizeFile(fileArg, fileArg);
    process.stdout.write(result + '\n');
  } else {
    const rl = createInterface({ input: process.stdin });
    const lines = [];
    rl.on('line', l => lines.push(l));
    rl.on('close', () => process.stdout.write(humanize(lines.join('\n')) + '\n'));
  }
}
