import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { runWithConcurrency } from '../lib/concurrency.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

export const DEFAULT_LINK_CONCURRENCY = 8;
export const DEFAULT_LINK_TIMEOUT = 10_000;

const USER_AGENT = `hihtml/${version} link-checker`;

const RE_ATTR = /\b(?:href|src|action)\s*=\s*(?:"(https?:\/\/[^"\s>]+)"|'(https?:\/\/[^'\s>]+)'|(https?:\/\/[^\s"'`=<>]+))/gi;
const RE_SRCSET = /\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;

/**
 * @typedef {Object} ResultLinksUrl
 * @property {string} url
 * @property {number|null} status
 * @property {boolean} ok
 * @property {boolean} [skipped]
 * @property {string} [warning]
 * @property {number} [redirectStatus]
 * @property {string} [error]
 */

/**
 * @typedef {Object} ResultLinksFile
 * @property {string} path
 * @property {ResultLinksUrl[]} links
 * @property {number} countBroken
 * @property {string} [error]
 */

/**
 * @typedef {Object} ResultLinks
 * @property {ResultLinksFile[]} files
 * @property {number} countBroken
 * @property {number} countChecked
 * @property {number} countSkipped
 * @property {number} countFileErrors
 */

/**
 * Extract unique http/https URLs from HTML content.
 * @param {string} content
 * @returns {string[]}
 */
function extractUrls(content) {
  const urls = new Set();

  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1</style>');

  for (const m of stripped.matchAll(RE_ATTR)) {
    const rawUrl = m[1] ?? m[2] ?? m[3];
    try { urls.add(new URL(rawUrl).href.split('#')[0]); } catch { /* skip malformed URLs */ }
  }

  for (const m of stripped.matchAll(RE_SRCSET)) {
    for (const entry of (m[1] ?? m[2]).split(',')) {
      const candidate = entry.trim().split(/\s+/)[0];
      if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
        try { urls.add(new URL(candidate).href.split('#')[0]); } catch { /* skip malformed URLs */ }
      }
    }
  }

  return [...urls];
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
        headers: { 'User-Agent': USER_AGENT },
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
 * @returns {Promise<ResultLinksUrl>}
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
 * @typedef {{ hostnames: Set<string>, prefixes: string[] }} IgnoreList
 */

/**
 * Pre-process an ignore list into hostname entries (Set for O(1) lookup) and prefix entries.
 * Entries containing a slash are treated as URL prefixes; others as hostnames (exact or subdomain).
 * @param {string[]} ignore
 * @returns {IgnoreList}
 */
function buildIgnoreList(ignore) {
  const normalized = ignore.map(e => e.trim().toLowerCase());
  return {
    hostnames: new Set(normalized.filter(e => !e.includes('/'))),
    prefixes: normalized.filter(e => e.includes('/')).map(e => e.replace(/\/+$/, '')),
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
  const urlLower = url.toLowerCase();
  for (const prefix of prefixes) {
    if (urlLower.startsWith(prefix)) return true;
  }
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return false; }
  if (hostnames.has(hostname)) return true;
  for (const h of hostnames) {
    if (hostname.endsWith(`.${h}`)) return true;
  }
  return false;
}

/**
 * Check all external http/https URLs (`href`, `src`, `srcset`, `action` attributes) found in the given HTML files.
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
  /** @type {Map<string, { urls: string[], error?: string }>} */
  const fileData = new Map();

  await runWithConcurrency(filePaths, concurrency, async (filePath) => {
    let content = contents?.get(filePath);
    if (content === undefined) {
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        fileData.set(filePath, { urls: [], error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    fileData.set(filePath, { urls: extractUrls(content) });
  });

  const allUrls = new Set();
  for (const { urls } of fileData.values()) {
    for (const url of urls) allUrls.add(url);
  }

  const ignoreList = buildIgnoreList(ignore);
  const toCheck = new Set();
  const toSkip = new Set();
  for (const url of allUrls) {
    if (isIgnored(url, ignoreList)) toSkip.add(url);
    else toCheck.add(url);
  }

  onStart?.(toCheck.size);

  /** @type {Map<string, ResultLinksUrl>} */
  const urlResults = new Map();

  for (const url of toSkip) {
    urlResults.set(url, { url, status: null, ok: true, skipped: true });
  }

  await runWithConcurrency([...toCheck], concurrency, async (url) => {
    urlResults.set(url, await checkUrl(url, { timeout, warnOnPermanentRedirects }));
    onProgress?.();
  });

  const files = filePaths.map(filePath => {
    const data = fileData.get(filePath) ?? { urls: [], error: 'Unknown error' };
    if (data.error) return /** @type {ResultLinksFile} */ ({ path: filePath, links: [], countBroken: 0, error: data.error });

    const links = data.urls.map(url => /** @type {ResultLinksUrl} */ ({ ...urlResults.get(url), url }));
    const countBroken = links.filter(l => !l.ok).length;
    return /** @type {ResultLinksFile} */ ({ path: filePath, links, countBroken });
  });

  const countBroken = [...urlResults.values()].filter(r => !r.ok).length;
  const countSkipped = toSkip.size;
  const countFileErrors = files.filter(f => f.error !== undefined).length;
  return { files, countBroken, countChecked: toCheck.size, countSkipped, countFileErrors };
}

const SYNTHETIC_PATH = '(string input)';

/**
 * Check all external http/https URLs found in an HTML string.
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