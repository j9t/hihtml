import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = '.hihtml.json';

/**
 * @param {unknown} config
 * @param {string} source
 * @returns {asserts config is import('./config.js').HihtmlConfig}
 */
function validateConfig(config, source) {
  const c = /** @type {Record<string, unknown>} */ (config);
  const isStringArray = (/** @type {unknown} */ v) => Array.isArray(v) && v.every(e => typeof e === 'string');

  if (c.extensions !== undefined && !isStringArray(c.extensions))
    throw new Error(`${source}: \`extensions\` must be an array of strings`);
  if (c.ignore !== undefined && !isStringArray(c.ignore))
    throw new Error(`${source}: \`ignore\` must be an array of strings`);

  if (c.validation !== undefined) {
    if (typeof c.validation !== 'object' || c.validation === null || Array.isArray(c.validation))
      throw new Error(`${source}: \`validation\` must be an object`);
    const v = /** @type {Record<string, unknown>} */ (c.validation);
    if (v.preset !== undefined && typeof v.preset !== 'string')
      throw new Error(`${source}: \`validation.preset\` must be a string`);
    if (v.ignore !== undefined && !isStringArray(v.ignore))
      throw new Error(`${source}: \`validation.ignore\` must be an array of strings`);
  }

  if (c.links !== undefined) {
    if (typeof c.links !== 'object' || c.links === null || Array.isArray(c.links))
      throw new Error(`${source}: \`links\` must be an object`);
    const l = /** @type {Record<string, unknown>} */ (c.links);
    if (l.timeout !== undefined && (typeof l.timeout !== 'number' || l.timeout <= 0 || !Number.isFinite(l.timeout)))
      throw new Error(`${source}: \`links.timeout\` must be a positive number`);
    if (l.concurrency !== undefined && (!Number.isInteger(l.concurrency) || /** @type {number} */ (l.concurrency) < 1))
      throw new Error(`${source}: \`links.concurrency\` must be a positive integer`);
    if (l.warnOnPermanentRedirects !== undefined && typeof l.warnOnPermanentRedirects !== 'boolean')
      throw new Error(`${source}: \`links.warnOnPermanentRedirects\` must be a boolean`);
    if (l.ignore !== undefined && !isStringArray(l.ignore))
      throw new Error(`${source}: \`links.ignore\` must be an array of strings`);
  }

  if (c.minification !== undefined) {
    if (typeof c.minification !== 'object' || c.minification === null || Array.isArray(c.minification))
      throw new Error(`${source}: \`minification\` must be an object`);
    const m = /** @type {Record<string, unknown>} */ (c.minification);
    if (m.preset !== undefined && typeof m.preset !== 'string')
      throw new Error(`${source}: \`minification.preset\` must be a string`);
    if (m.options !== undefined && (typeof m.options !== 'object' || m.options === null || Array.isArray(m.options)))
      throw new Error(`${source}: \`minification.options\` must be an object`);
  }
}

/**
 * @typedef {Object} HihtmlConfig
 * @property {string[]} [extensions]
 * @property {string[]} [ignore]
 * @property {{ preset?: string, ignore?: string[] }} [validation]
 * @property {{ timeout?: number, concurrency?: number, warnOnPermanentRedirects?: boolean, ignore?: string[] }} [links]
 * @property {{ preset?: string, options?: Record<string, unknown> }} [minification]
 */

/**
 * Load configuration from a specific file, .hihtml.json, or the `"hihtml"` key in package.json.
 * When `filePath` is given, only that file is read (no CWD fallback).
 * If the file contains a `"hihtml"` key, that key’s value is used; otherwise the root object is used.
 * @param {string} [cwd]
 * @param {string} [filePath]
 * @returns {Promise<HihtmlConfig>}
 */
export async function loadConfig(cwd = process.cwd(), filePath = undefined) {
  if (filePath !== undefined) {
    const resolved = path.resolve(cwd, filePath);
    let parsed;
    try {
      const content = await fs.promises.readFile(resolved, 'utf8');
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Error reading settings file ${resolved}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Settings file ${resolved} must contain a JSON object`);
    }
    if (parsed.hihtml !== undefined) {
      if (typeof parsed.hihtml !== 'object' || parsed.hihtml === null || Array.isArray(parsed.hihtml)) {
        throw new Error(`\`hihtml\` key in ${resolved} must be a JSON object`);
      }
      validateConfig(parsed.hihtml, resolved);
      return parsed.hihtml;
    }
    validateConfig(parsed, resolved);
    return parsed;
  }

  const configPath = path.join(cwd, CONFIG_FILE);
  let parsed;
  try {
    const content = await fs.promises.readFile(configPath, 'utf8');
    parsed = JSON.parse(content);
  } catch (err) {
    const nodeErr = /** @type {NodeJS.ErrnoException} */ (err);
    if (nodeErr.code !== 'ENOENT') throw new Error(`Error reading ${CONFIG_FILE}: ${nodeErr.message}`, { cause: err });
  }
  if (parsed !== undefined) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${CONFIG_FILE} must contain a JSON object`);
    }
    validateConfig(parsed, CONFIG_FILE);
    return parsed;
  }

  const pkgPath = path.join(cwd, 'package.json');
  let pkg;
  try {
    const content = await fs.promises.readFile(pkgPath, 'utf8');
    pkg = JSON.parse(content);
  } catch (err) {
    const nodeErr = /** @type {NodeJS.ErrnoException} */ (err);
    if (nodeErr.code !== 'ENOENT') throw new Error(`Error reading package.json: ${nodeErr.message}`, { cause: err });
  }
  if (pkg?.hihtml !== undefined) {
    if (typeof pkg.hihtml !== 'object' || pkg.hihtml === null || Array.isArray(pkg.hihtml)) {
      throw new Error('`hihtml` in package.json must be a JSON object');
    }
    validateConfig(pkg.hihtml, 'package.json');
    return pkg.hihtml;
  }

  return {};
}
