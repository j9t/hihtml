import fs from 'node:fs';
import { DEFAULT_CONCURRENCY, runWithConcurrency } from '../lib/concurrency.js';

/**
 * @typedef {Object} ValidationMessage
 * @property {string} ruleId
 * @property {1|2} severity - 1 = warning, 2 = error
 * @property {string} message
 * @property {number} line
 * @property {number} col
 * @property {boolean} [ignored]
 */

/**
 * @typedef {Object} FileValidationResult
 * @property {string} path
 * @property {ValidationMessage[]} messages
 */

/**
 * @typedef {Object} ValidationResult
 * @property {FileValidationResult[]} files
 * @property {number} countErrors
 * @property {number} countWarnings
 * @property {number} countIgnored
 */

/** @type {Map<string, Promise<import('html-validate').HtmlValidate>>} */
const validatorCache = new Map();

/**
 * Return a shared promise for a cached HtmlValidate instance for the given preset.
 * Caching the promise rather than the resolved value means concurrent callers
 * share a single initialization rather than each racing past the cache check.
 * @param {string} preset
 * @returns {Promise<import('html-validate').HtmlValidate>}
 */
function getValidator(preset) {
  if (validatorCache.has(preset)) return /** @type {Promise<import('html-validate').HtmlValidate>} */ (validatorCache.get(preset));

  const promise = (async () => {
    let HtmlValidate;
    try {
      ({ HtmlValidate } = await import('html-validate'));
    } catch {
      throw new Error('Could not load HTML-validate. Ensure it is installed and check for breaking API changes.');
    }

    let validator;
    try {
      validator = new HtmlValidate({ extends: [`html-validate:${preset}`] });
    } catch (err) {
      throw new Error(`HTML-validate initialization failed—the package may have breaking changes: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    return validator;
  })();

  promise.catch(() => validatorCache.delete(preset));
  validatorCache.set(preset, promise);
  return promise;
}

/**
 * Validate HTML files using HTML-validate.
 * @param {string[]} filePaths
 * @param {{ preset?: string, ignore?: string[], concurrency?: number, contents?: Map<string, string>, onProgress?: () => void }} [options]
 * @returns {Promise<ValidationResult>}
 */
export async function validate(filePaths, { preset = 'standard', ignore = [], concurrency = DEFAULT_CONCURRENCY, contents, onProgress } = {}) {
  const ignoreSet = new Set(Array.isArray(ignore) ? ignore.map(String) : []);
  const validator = await getValidator(preset);

  const files = await runWithConcurrency(filePaths, concurrency, async (filePath) => {
    let content = contents?.get(filePath);

    if (content === undefined) {
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        onProgress?.();
        return /** @type {FileValidationResult} */ ({ path: filePath, messages: [{ ruleId: 'io-error', severity: /** @type {2} */ (2), message: err instanceof Error ? err.message : String(err), line: 0, col: 0 }] });
      }
    }

    let report;
    try {
      report = await Promise.resolve(validator.validateString(content, filePath));
    } catch (err) {
      throw new Error(`Error validating ${filePath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    const raw = report?.results?.[0]?.messages ?? [];
    /** @type {ValidationMessage[]} */
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
    return /** @type {FileValidationResult} */ ({ path: filePath, messages });
  });

  const countErrors = files.reduce((acc, f) => acc + f.messages.filter(m => m.severity === 2 && !m.ignored).length, 0);
  const countWarnings = files.reduce((acc, f) => acc + f.messages.filter(m => m.severity === 1 && !m.ignored).length, 0);
  const countIgnored = files.reduce((acc, f) => acc + f.messages.filter(m => m.ignored).length, 0);

  return { files, countErrors, countWarnings, countIgnored };
}