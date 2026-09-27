import fs from 'node:fs';
import { DEFAULT_CONCURRENCY, runWithConcurrency } from '../lib/concurrency.js';
import { setupError } from '../lib/config.js';

/**
 * @typedef {Object} MessageValidation
 * @property {string} ruleId
 * @property {1|2} severity - 1 = warning, 2 = error
 * @property {string} message
 * @property {number} line
 * @property {number} col
 * @property {boolean} [ignored]
 */

/**
 * @typedef {Object} ResultCodeValidationFile
 * @property {string} path
 * @property {MessageValidation[]} messages
 */

/**
 * @typedef {Object} ResultCodeValidation
 * @property {ResultCodeValidationFile[]} files
 * @property {number} countErrors
 * @property {number} countWarnings
 * @property {number} countIgnored
 */

// Intentionally unbounded: Keyed by preset combination, and HTML-validate exposes a
// fixed small set of presets, so this will never hold more than a handful of entries
/** @type {Map<string, Promise<import('html-validate').HtmlValidate>>} */
const validatorCache = new Map();

/**
 * Return a shared promise for a cached HtmlValidate instance for the given presets.
 * Caching the promise rather than the resolved value means concurrent callers
 * share a single initialization rather than each racing past the cache check.
 * @param {string[]} presets - In HTML-validate `extends` order (later presets override earlier ones)
 * @returns {Promise<import('html-validate').HtmlValidate>}
 */
function getValidator(presets) {
  const key = JSON.stringify(presets);
  if (validatorCache.has(key)) return /** @type {Promise<import('html-validate').HtmlValidate>} */ (validatorCache.get(key));

  const promise = (async () => {
    let HtmlValidate;
    try {
      ({ HtmlValidate } = await import('html-validate'));
    } catch {
      throw new Error('Could not load HTML-validate. Ensure it is installed and check for breaking API changes.');
    }

    // Resolving the config up front surfaces unknown presets as a setup error, not on each file
    const isResolvable = async (/** @type {string[]} */ names) => {
      try {
        await new HtmlValidate({ extends: names.map(name => `html-validate:${name}`) }).getConfigFor('page.html');
        return true;
      } catch {
        return false;
      }
    };
    if (!await isResolvable(presets)) {
      for (const preset of presets) {
        if (!await isResolvable([preset])) throw setupError(`Unknown HTML-validate preset \`${preset}\``);
      }
    }

    let validator;
    try {
      validator = new HtmlValidate({ extends: presets.map(preset => `html-validate:${preset}`) });
    } catch (err) {
      throw new Error(`HTML-validate initialization failed—the package may have breaking changes: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    return validator;
  })();

  promise.catch(() => validatorCache.delete(key));
  validatorCache.set(key, promise);
  return promise;
}

/**
 * Validate HTML files using HTML-validate.
 * @param {string[]} filePaths
 * @param {{ preset?: string | string[], ignore?: string[], concurrency?: number, contents?: Map<string, string>, onProgress?: () => void }} [options]
 * @returns {Promise<ResultCodeValidation>}
 */
export async function validate(filePaths, { preset = 'standard', ignore = [], concurrency = DEFAULT_CONCURRENCY, contents, onProgress } = {}) {
  const presets = Array.isArray(preset) ? preset.map(String) : [preset];
  if (presets.length === 0) throw setupError('At least one HTML-validate preset is required');
  const ignoreSet = new Set(Array.isArray(ignore) ? ignore.map(String) : []);
  const validator = await getValidator(presets);

  const files = await runWithConcurrency(filePaths, concurrency, async (filePath) => {
    let content = contents?.get(filePath);

    if (content === undefined) {
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        onProgress?.();
        return /** @type {ResultCodeValidationFile} */ ({ path: filePath, messages: [{ ruleId: 'io-error', severity: /** @type {2} */ (2), message: err instanceof Error ? err.message : String(err), line: 0, col: 0 }] });
      }
    }

    let report;
    try {
      report = await Promise.resolve(validator.validateString(content, filePath));
    } catch (err) {
      throw new Error(`Error validating ${filePath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    const raw = report?.results?.[0]?.messages ?? [];
    /** @type {MessageValidation[]} */
    const messages = raw.map(m => {
      const ruleId = String(m.ruleId ?? 'unknown');
      return {
        ruleId,
        severity: /** @type {1|2} */ (m.severity === 1 ? 1 : 2),
        message: String(m.message ?? ''),
        line: Number(m.line ?? 0),
        col: Number(m.column ?? 0),
        ...(ignoreSet.has(ruleId) ? { ignored: true } : {}),
      };
    });

    onProgress?.();
    return /** @type {ResultCodeValidationFile} */ ({ path: filePath, messages });
  });

  const countErrors = files.reduce((acc, f) => acc + f.messages.filter(m => m.severity === 2 && !m.ignored).length, 0);
  const countWarnings = files.reduce((acc, f) => acc + f.messages.filter(m => m.severity === 1 && !m.ignored).length, 0);
  const countIgnored = files.reduce((acc, f) => acc + f.messages.filter(m => m.ignored).length, 0);

  return { files, countErrors, countWarnings, countIgnored };
}