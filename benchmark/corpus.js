// Synthetic benchmark corpus for hihtml.
//
// Generates a deterministic set of HTML documents that exercise hihtml’s
// CPU-bound paths: Link extraction and fragment checking (check-links),
// validation and deprecated-markup checks (check-code), and minification
// (minify). Every absolute URL points at an `example.*` host, and the
// benchmark passes those hosts to the link checker’s `ignore` list, so no
// network request is ever made.

import fs from 'node:fs/promises';
import path from 'node:path';

// All hostnames the generated documents link to; benchmarks must ignore them
// to keep runs offline
export const CORPUS_HOSTS = ['example.com', 'example.org', 'example.net'];

// Seeded PRNG (mulberry32) so every run generates byte-identical documents
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ar', 'be', 'ca', 'de', 'el', 'fi', 'go', 'ha', 'in', 'jo', 'ka', 'le', 'mo', 'na', 'or', 'pe', 'qa', 'ra', 'si', 'to', 'us', 'va', 'wa', 'xa', 'ya', 'ze'];

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

function word(rnd, min = 2, max = 9) {
  const n = min + Math.floor(rnd() * (max - min));
  let out = '';
  for (let i = 0; i < n; i++) out += pick(rnd, SYLLABLES);
  return out;
}

function sentence(rnd) {
  const n = 6 + Math.floor(rnd() * 10);
  const words = [];
  for (let i = 0; i < n; i++) words.push(word(rnd));
  return words.join(' ') + '.';
}

function paragraph(rnd) {
  const n = 3 + Math.floor(rnd() * 4);
  const sentences = [];
  for (let i = 0; i < n; i++) sentences.push(sentence(rnd));
  return `<p>${sentences.join(' ')}</p>`;
}

function prose(rnd, paragraphs) {
  const out = [];
  for (let i = 0; i < paragraphs; i++) out.push(paragraph(rnd));
  return out.join('\n');
}

const header = (rnd, title) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<!-- ${sentence(rnd)} <a href="https://example.com/${word(rnd)}">${word(rnd)}</a> -->
<style>
body { color: #333; margin: 0 auto; max-width: 40em; }
::before { content: "https://example.com/${word(rnd)}"; }
</style>
</head>
<body>
`;

const footer = (rnd) => `<footer>
<p>${sentence(rnd)}</p>
<script>
var tracker = "https://example.com/${word(rnd)}";
console.log(tracker);
</script>
</footer>
</body>
</html>
`;

// A typical small page
function smallPage() {
  const rnd = mulberry32(1);
  return header(rnd, 'Small page') + `<header>
<nav><a href="/">Home</a> <a href="#main">Main</a> <a href="https://example.com/about">About</a></nav>
</header>
<main id="main">
<h1>${sentence(rnd)}</h1>
${prose(rnd, 12)}
<ul>${Array.from({ length: 8 }, () => `<li>${word(rnd)}</li>`).join('')}</ul>
</main>
` + footer(rnd);
}

// A long-form article with headings, anchors, and lists
function articlePage() {
  const rnd = mulberry32(2);
  const sections = [];
  for (let i = 0; i < 24; i++) {
    sections.push(`<section id="section-${i}">
<h2><a href="#section-${i}">${sentence(rnd)}</a></h2>
${prose(rnd, 6)}
<blockquote><p>${sentence(rnd)}</p></blockquote>
${prose(rnd, 4)}
</section>`);
  }
  return header(rnd, 'Article') + `<main>
<h1>${sentence(rnd)}</h1>
<nav>${sections.map((_, i) => `<a href="#section-${i}">${i + 1}</a>`).join(' ')}</nav>
${sections.join('\n')}
</main>
` + footer(rnd);
}

// A directory-style page dominated by unique external links, srcsets, and fragment links
function linksPage() {
  const rnd = mulberry32(3);
  const parts = [header(rnd, 'Links')];

  parts.push('<nav>');
  for (let i = 0; i < 300; i++) {
    const host = CORPUS_HOSTS[i % CORPUS_HOSTS.length];
    parts.push(`<a href="https://sub${i % 40}.${host}/path/${word(rnd)}?q=${i}#f-${i}">${word(rnd, 3, 6)}</a>`);
  }
  parts.push('</nav>');

  parts.push('<div class="gallery">');
  for (let i = 0; i < 200; i++) {
    parts.push(`<img src="https://img.${CORPUS_HOSTS[2]}/a/${i}.webp" srcset="https://img.${CORPUS_HOSTS[2]}/a/${i}-200.webp 200w, https://img.${CORPUS_HOSTS[2]}/a/${i}-400.webp 400w, https://img.${CORPUS_HOSTS[2]}/a/${i}-800.webp 800w" alt="${word(rnd, 3, 6)}" width="200" height="200">`);
  }
  parts.push('</div>');

  parts.push('<ol>');
  for (let i = 0; i < 500; i++) {
    parts.push(`<li><a href="#item-${i}">${word(rnd, 3, 5)}</a></li>`);
  }
  parts.push('</ol>');

  // 450 of the 500 fragment targets exist, so fragment checking has misses
  parts.push('<div>');
  for (let i = 0; i < 450; i++) {
    parts.push(`<div id="item-${i}"><p>${sentence(rnd)}</p></div>`);
  }
  parts.push('</div>');

  parts.push(prose(rnd, 20));
  parts.push(footer(rnd));
  return parts.join('\n');
}

// A page dominated by dense, deeply nested markup and attributes
function markupPage() {
  const rnd = mulberry32(4);
  const parts = [header(rnd, 'Markup')];

  let nest = '';
  for (let i = 0; i < 20; i++) {
    nest += `<div class="${word(rnd, 3, 6)}" data-id="${i}" style="margin: ${i}px">`;
  }
  nest += prose(rnd, 2);
  for (let i = 0; i < 20; i++) nest += '</div>';
  parts.push(nest);

  parts.push('<table>');
  for (let r = 0; r < 50; r++) {
    parts.push('<tr>');
    for (let c = 0; c < 10; c++) {
      parts.push(`<td id="cell-${r}-${c}" class="${word(rnd, 2, 4)}" title="${word(rnd, 3, 8)}">${word(rnd, 2, 5)}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</table>');

  const list = (depth) => {
    if (depth === 0) return '';
    let out = depth % 2 ? '<ul>' : '<ol>';
    for (let i = 0; i < 6; i++) {
      out += `<li><span data-n="${depth}-${i}">${word(rnd, 2, 6)}</span>${list(depth - 1)}</li>`;
    }
    return out + (depth % 2 ? '</ul>' : '</ol>');
  };
  parts.push(list(5));

  parts.push(`<script>
var template = "<a href=\\"https://example.com/${word(rnd)}\\">${word(rnd)}</a>";
var urls = ["https://example.org/${word(rnd)}", "https://example.net/${word(rnd)}"];
</script>`);

  parts.push(prose(rnd, 15));
  parts.push(footer(rnd));
  return parts.join('\n');
}

/** @typedef {{ name: string, content: string }} CorpusFile */

/**
 * Generate the benchmark corpus. Deterministic: identical on every run.
 * @returns {CorpusFile[]}
 */
export function generate() {
  return [
    { name: 'small', content: smallPage() },
    { name: 'article', content: articlePage() },
    { name: 'links', content: linksPage() },
    { name: 'markup', content: markupPage() },
  ];
}

/**
 * Generate the corpus and write it into `dir` as `<name>.html` files.
 * Existing files are rewritten, keeping the corpus in sync with the generator.
 * @param {string} dir
 * @returns {Promise<CorpusFile[]>}
 */
export async function write(dir) {
  const files = generate();
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(files.map(file => fs.writeFile(path.join(dir, file.name + '.html'), file.content, 'utf8')));
  return files;
}