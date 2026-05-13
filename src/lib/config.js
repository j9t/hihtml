import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = '.hihtml.json';

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
      return parsed.hihtml;
    }
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
    return pkg.hihtml;
  }

  return {};
}
