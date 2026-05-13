import fs from 'node:fs';
import { checkMarkup } from 'obsohtml';
import { DEFAULT_CONCURRENCY, runWithConcurrency } from '../lib/concurrency.js';
import { validate } from './validate.js';
import { read } from '../lib/files.js';

/**
 * @typedef {Object} ResultCodeDeprecationFile
 * @property {string} path
 * @property {string[]} elements
 * @property {string[]} attributes
 * @property {string} [error]
 */

/**
 * @typedef {Object} ResultCodeDeprecation
 * @property {ResultCodeDeprecationFile[]} files
 * @property {number} countIssues
 */

/**
 * @typedef {Object} ResultCode
 * @property {import('./validate.js').ResultCodeValidation} validation
 * @property {ResultCodeDeprecation} deprecation
 */

/**
 * @param {string[]} filePaths
 * @param {{ concurrency?: number, contents?: Map<string, string> }} [options]
 * @returns {Promise<ResultCodeDeprecation>}
 */
async function checkDeprecated(filePaths, { concurrency = DEFAULT_CONCURRENCY, contents } = {}) {
  const files = await runWithConcurrency(filePaths, concurrency, async (filePath) => {
    let content = contents?.get(filePath);

    if (content === undefined) {
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        return /** @type {ResultCodeDeprecationFile} */ ({ path: filePath, elements: [], attributes: [], error: err instanceof Error ? err.message : String(err) });
      }
    }

    let result;
    try {
      result = checkMarkup(content);
    } catch (err) {
      throw new Error(`ObsoHTML API error—the package may have breaking changes: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    return /** @type {ResultCodeDeprecationFile} */ ({ path: filePath, elements: result.elements, attributes: result.attributes });
  });

  const countIssues = files.reduce((acc, f) => acc + f.elements.length + f.attributes.length, 0);
  return { files, countIssues };
}

/**
 * Validate HTML files and check for deprecated markup.
 * @param {string[]} filePaths
 * @param {{ preset?: string, ignore?: string[], concurrency?: number, contents?: Map<string, string>, onProgress?: () => void }} [options]
 * @returns {Promise<ResultCode>}
 */
export async function checkCode(filePaths, { preset = 'standard', ignore = [], concurrency = DEFAULT_CONCURRENCY, contents, onProgress } = {}) {
  const resolvedContents = contents ?? await read(filePaths, { concurrency });
  const [validateResult, deprecatedResult] = await Promise.all([
    validate(filePaths, { preset, ignore, concurrency, contents: resolvedContents, onProgress }),
    checkDeprecated(filePaths, { concurrency, contents: resolvedContents }),
  ]);
  return { validation: validateResult, deprecation: deprecatedResult };
}

const SYNTHETIC_PATH = '(string input)';

/**
 * Validate an HTML string and check for deprecated markup.
 * @param {string} content
 * @param {{ preset?: string, ignore?: string[] }} [options]
 * @returns {Promise<ResultCode>}
 */
export async function checkCodeString(content, { preset = 'standard', ignore = [] } = {}) {
  return checkCode([SYNTHETIC_PATH], { preset, ignore, contents: new Map([[SYNTHETIC_PATH, content]]) });
}