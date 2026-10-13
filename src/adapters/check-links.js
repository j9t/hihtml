import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { decodeHTMLAttribute } from 'entities';
import { runWithConcurrency } from '../lib/concurrency.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

export const DEFAULT_LINK_CONCURRENCY = 8;
export const DEFAULT_LINK_TIMEOUT = 10_000;

const USER_AGENT = `hihtml/${version} link-checker`;

const RE_ATTR = /\b(?:href|src|action)\s*=\s*(?:"(https?:\/\/[^"\s>]+)"|'(https?:\/\/[^'\s>]+)'|(https?:\/\/[^\s"'`=<>]+))/gi;
const RE_SRCSET = /\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
// As in HTML’s tokenizer, quotes only delimit attribute values right after `=`
const RE_TAG = /<([a-z][^\s/>]*)((?:=\s*"[^"]*"|=\s*'[^']*'|[^>])*)>/gi;
const RE_TAG_ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * @typedef {Object} ResultLinksUrl
 * @property {string} url
 * @property {number[]} lines
 * @property {number|null} status
 * @property {boolean} ok
 * @property {boolean} [skipped]
 * @property {string} [warning]
 * @property {number} [redirectStatus]
 * @property {string} [error]
 */

/**
 * @typedef {Object} ResultLinksFragment
 * @property {string} fragment
 * @property {number[]} lines
 */

/**
 * @typedef {Object} ResultLinksFile
 * @property {string} path
 * @property {ResultLinksUrl[]} links
 * @property {ResultLinksFragment[]} fragmentsMissing
 * @property {number} countBroken
 * @property {string} [error]
 */

/**
 * @typedef {Object} ResultLinks
 * @property {ResultLinksFile[]} files
 * @property {number} countBroken
 * @property {number} countChecked
 * @property {number} countSkipped
 * @property {number} countFragmentsChecked
 * @property {number} countFragmentsMissing
 * @property {number} countFileErrors
 */

/**
 * Blank out comments and `script`/`style` bodies, keeping offsets and line breaks intact.
 * @param {string} content
 * @returns {string}
 */
function strip(content) {
  const blank = (/** @type {string} */ text) => text.replace(/[^\n]/g, ' ');
  return content
    .replace(/<!--[\s\S]*?-->/g, match => blank(match))
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, open, body, close) => open + blank(body) + close)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, body, close) => open + blank(body) + close);
}

/**
 * Return a function mapping a character offset to its 1-based line number.
 * @param {string} content
 * @returns {(offset: number) => number}
 */
function lineFinder(content) {
  const starts = [0];
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) starts.push(i + 1);
  return offset => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Add a line to the list stored under `key`, creating the list if needed.
 * @param {Map<string, number[]>} map
 * @param {string} key
 * @param {number} line
 */
function addLine(map, key, line) {
  const lines = map.get(key);
  if (!lines) map.set(key, [line]);
  else if (lines.at(-1) !== line) lines.push(line);
}

/**
 * Extract unique http/https URLs from (stripped) HTML content, with the lines they appear on.
 * @param {string} stripped
 * @param {(offset: number) => number} lineAt
 * @returns {Map<string, number[]>}
 */
function extractUrls(stripped, lineAt) {
  /** @type {Map<string, number[]>} */
  const urls = new Map();

  for (const m of stripped.matchAll(RE_ATTR)) {
    const rawUrl = m[1] ?? m[2] ?? m[3];
    try { addLine(urls, new URL(rawUrl).href.split('#')[0], lineAt(m.index)); } catch { /* skip malformed URLs */ }
  }

  for (const m of stripped.matchAll(RE_SRCSET)) {
    const value = m[1] ?? m[2];
    // The value ends right before the closing quote
    const offsetValue = m.index + m[0].length - 1 - value.length;
    for (const entry of value.matchAll(/(?<=^|,)\s*([^\s,]+)/dg)) {
      const candidate = entry[1];
      if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
        const offset = offsetValue + /** @type {number[][]} */ (entry.indices)[1][0];
        try { addLine(urls, new URL(candidate).href.split('#')[0], lineAt(offset)); } catch { /* skip malformed URLs */ }
      }
    }
  }

  for (const [url, lines] of urls) urls.set(url, [...new Set(lines)].sort((a, b) => a - b));
  return urls;
}

/**
 * Whether a fragment points to the top of the document or to an existing target, per HTML’s “find a potential indicated element” algorithm
 * @param {string} fragment - Including the leading `#`
 * @param {Set<string>} targets - `id` values and `name` values of `a` elements
 * @returns {boolean}
 */
function isFragmentResolvable(fragment, targets) {
  let value = fragment.slice(1);
  const indexDirective = value.indexOf(':~:');
  if (indexDirective !== -1) value = value.slice(0, indexDirective);
  if (value === '' || targets.has(value)) return true;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* keep malformed encoding as is */ }
  return targets.has(decoded) || decoded.toLowerCase() === 'top';
}

/**
 * Find same-document fragment links (`href="#…"`) without a matching target.
 * Skipped when the document sets a `base` URL, as fragments then resolve against another document.
 * @param {string} stripped
 * @param {(offset: number) => number} lineAt
 * @param {string[]} ignoreFragments - Fragment prefixes to skip
 * @returns {{ fragmentsMissing: ResultLinksFragment[], countChecked: number }}
 */
function checkFragments(stripped, lineAt, ignoreFragments) {
  /** @type {Set<string>} */
  const targets = new Set();
  /** @type {Map<string, number[]>} */
  const fragments = new Map();
  /** @type {Map<string, string>} */
  const fragmentsDecoded = new Map();

  for (const tag of stripped.matchAll(RE_TAG)) {
    const tagName = tag[1].toLowerCase();
    const offsetAttrs = tag.index + 1 + tag[1].length;
    for (const attr of tag[2].matchAll(RE_TAG_ATTR)) {
      const attrName = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4];
      if (value === undefined) continue;
      if (attrName === 'id' || (attrName === 'name' && tagName === 'a')) targets.add(decodeHTMLAttribute(value));
      if (attrName === 'href') {
        if (tagName === 'base') return { fragmentsMissing: [], countChecked: 0 };
        // Matched decoded, as browsers see it, but reported as written
        const fragment = value.trim();
        const decoded = decodeHTMLAttribute(fragment).trim();
        if (decoded.startsWith('#') && !ignoreFragments.some(prefix => decoded.startsWith(prefix) || fragment.startsWith(prefix))) {
          addLine(fragments, fragment, lineAt(offsetAttrs + /** @type {number} */ (attr.index)));
          fragmentsDecoded.set(fragment, decoded);
        }
      }
    }
  }

  const fragmentsMissing = [...fragments]
    .filter(([fragment]) => !isFragmentResolvable(/** @type {string} */ (fragmentsDecoded.get(fragment)), targets))
    .map(([fragment, lines]) => ({ fragment, lines }));
  return { fragmentsMissing, countChecked: fragments.size };
}

/**
 * Make a single HTTP/HTTPS request without following redirects.
 * @param {string} url
 * @param {string} method
 * @param {number} timeout
 * @returns {Promise<{ status: number, location: string | undefined }>}
 */
function requestSingle(url, method, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: (parsed.pathname || '/') + parsed.search,
        method,
        headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
        signal: AbortSignal.timeout(timeout),
      },
      res => {
        res.resume();
        const loc = res.headers['location'];
        resolve({ status: res.statusCode ?? 0, location: Array.isArray(loc) ? loc[0] : loc });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

/**
 * Check a single URL, following redirects manually (up to 10 hops).
 * Falls back from HEAD to GET on 405. Optionally warns on permanent redirects.
 * @param {string} url
 * @param {{ timeout?: number, warnOnPermanentRedirects?: boolean }} [options]
 * @returns {Promise<Omit<ResultLinksUrl, 'lines'>>}
 */
async function checkUrl(url, { timeout = DEFAULT_LINK_TIMEOUT, warnOnPermanentRedirects = false } = {}) {
  let currentUrl = url;
  let method = 'HEAD';
  let redirectCount = 0;
  let warning;
  /** @type {number | undefined} */
  let redirectStatus;
  let isFirstRequest = true;

  try {
    while (redirectCount < 10) {
      const { status, location } = await requestSingle(currentUrl, method, timeout);

      if (status === 405 && method === 'HEAD') {
        method = 'GET';
        continue;
      }

      if (status >= 300 && status < 400) {
        if (!location) return { url, status, ok: false };

        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl).href;
        } catch {
          return { url, status, ok: false, error: 'Invalid redirect URL' };
        }

        if (isFirstRequest && warnOnPermanentRedirects && (status === 301 || status === 308)) {
          warning = 'permanent-redirect';
          redirectStatus = status;
        }

        currentUrl = nextUrl;
        redirectCount++;
        isFirstRequest = false;
        continue;
      }

      return {
        url, status, ok: status >= 200 && status < 300,
        ...(warning ? { warning, redirectStatus } : {}),
      };
    }

    return { url, status: null, ok: false, error: 'Too many redirects' };
  } catch (err) {
    const name = /** @type {any} */ (err)?.name ?? '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { url, status: null, ok: false, error: 'Timeout' };
    }
    return { url, status: null, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @typedef {{ hostnames: Set<string>, prefixes: string[], fragments: string[] }} IgnoreList
 */

/**
 * Pre-process an ignore list into hostname entries (Set for O(1) lookup), prefix entries, and fragment prefixes.
 * Entries starting with `#` are treated as (case-sensitive) fragment prefixes; entries containing a slash
 * as URL prefixes; others as hostnames (exact or subdomain).
 * @param {string[]} ignore
 * @returns {IgnoreList}
 */
function buildIgnoreList(ignore) {
  const trimmed = ignore.map(e => e.trim());
  const normalized = trimmed.filter(e => !e.startsWith('#')).map(e => e.toLowerCase());
  return {
    hostnames: new Set(normalized.filter(e => !e.includes('/'))),
    prefixes: normalized.filter(e => e.includes('/')).map(e => e.replace(/\/+$/, '')),
    fragments: trimmed.filter(e => e.startsWith('#')),
  };
}

/**
 * Returns true if the URL matches any entry in the pre-processed ignore list.
 * @param {string} url
 * @param {IgnoreList} ignoreList
 * @returns {boolean}
 */
function isIgnored(url, { hostnames, prefixes }) {
  if (hostnames.size === 0 && prefixes.length === 0) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  for (const prefix of prefixes) {
    const target = prefix.startsWith('/')
      ? parsed.pathname.toLowerCase()
      : (parsed.origin + parsed.pathname).toLowerCase();
    if (target === prefix || target.startsWith(prefix + '/')) return true;
  }
  const { hostname } = parsed;
  if (hostnames.has(hostname)) return true;
  for (const h of hostnames) {
    if (hostname.endsWith(`.${h}`)) return true;
  }
  return false;
}

/**
 * Check all external http/https URLs (`href`, `src`, `srcset`, `action` attributes) found in the given HTML files,
 * and whether same-document fragment links have a target.
 * Each unique URL is checked once; results are mapped back to every file it appears in.
 * @param {string[]} filePaths
 * @param {{
 *   concurrency?: number,
 *   timeout?: number,
 *   warnOnPermanentRedirects?: boolean,
 *   ignore?: string[],
 *   contents?: Map<string, string>,
 *   onProgress?: () => void,
 *   onStart?: (total: number) => void,
 * }} [options]
 * @returns {Promise<ResultLinks>}
 */
export async function checkLinks(filePaths, {
  concurrency = DEFAULT_LINK_CONCURRENCY,
  timeout = DEFAULT_LINK_TIMEOUT,
  warnOnPermanentRedirects = false,
  ignore = [],
  contents,
  onProgress,
  onStart,
} = {}) {
  const ignoreList = buildIgnoreList(ignore);

  /** @type {Map<string, { urls: Map<string, number[]>, fragmentsMissing: ResultLinksFragment[], countFragmentsChecked: number, error?: string }>} */
  const fileData = new Map();

  await runWithConcurrency(filePaths, concurrency, async (filePath) => {
    let content = contents?.get(filePath);
    if (content === undefined) {
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        fileData.set(filePath, { urls: new Map(), fragmentsMissing: [], countFragmentsChecked: 0, error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    const stripped = strip(content);
    const lineAt = lineFinder(stripped);
    const { fragmentsMissing, countChecked } = checkFragments(stripped, lineAt, ignoreList.fragments);
    fileData.set(filePath, { urls: extractUrls(stripped, lineAt), fragmentsMissing, countFragmentsChecked: countChecked });
  });

  const allUrls = new Set();
  for (const { urls } of fileData.values()) {
    for (const url of urls.keys()) allUrls.add(url);
  }

  const toCheck = new Set();
  const toSkip = new Set();
  for (const url of allUrls) {
    if (isIgnored(url, ignoreList)) toSkip.add(url);
    else toCheck.add(url);
  }

  onStart?.(toCheck.size);

  /** @type {Map<string, Omit<ResultLinksUrl, 'lines'>>} */
  const urlResults = new Map();

  for (const url of toSkip) {
    urlResults.set(url, { url, status: null, ok: true, skipped: true });
  }

  await runWithConcurrency([...toCheck], concurrency, async (url) => {
    urlResults.set(url, await checkUrl(url, { timeout, warnOnPermanentRedirects }));
    onProgress?.();
  });

  const files = filePaths.map(filePath => {
    const data = fileData.get(filePath) ?? { urls: new Map(), fragmentsMissing: [], countFragmentsChecked: 0, error: 'Unknown error' };
    if (data.error) return /** @type {ResultLinksFile} */ ({ path: filePath, links: [], fragmentsMissing: [], countBroken: 0, error: data.error });

    const links = [...data.urls].map(([url, lines]) => /** @type {ResultLinksUrl} */ ({ ...urlResults.get(url), url, lines }));
    const countBroken = links.filter(l => !l.ok).length;
    return /** @type {ResultLinksFile} */ ({ path: filePath, links, fragmentsMissing: data.fragmentsMissing, countBroken });
  });

  const countBroken = [...urlResults.values()].filter(r => !r.ok).length;
  const countSkipped = toSkip.size;
  const countFileErrors = files.filter(f => f.error !== undefined).length;
  const countFragmentsChecked = [...fileData.values()].reduce((acc, d) => acc + d.countFragmentsChecked, 0);
  const countFragmentsMissing = files.reduce((acc, f) => acc + f.fragmentsMissing.length, 0);
  return { files, countBroken, countChecked: toCheck.size, countSkipped, countFragmentsChecked, countFragmentsMissing, countFileErrors };
}

const SYNTHETIC_PATH = '(string input)';

/**
 * Check all external http/https URLs and same-document fragment links found in an HTML string.
 * @param {string} content
 * @param {{
 *   concurrency?: number,
 *   timeout?: number,
 *   warnOnPermanentRedirects?: boolean,
 *   ignore?: string[],
 *   onProgress?: () => void,
 *   onStart?: (total: number) => void,
 * }} [options]
 * @returns {Promise<ResultLinks>}
 */
export async function checkLinksString(content, options = {}) {
  return checkLinks([SYNTHETIC_PATH], { ...options, contents: new Map([[SYNTHETIC_PATH, content]]) });
}