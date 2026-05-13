import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONCURRENCY, runWithConcurrency } from '../lib/concurrency.js';

/**
 * @typedef {Object} ResultMinificationFile
 * @property {string} path
 * @property {number} sizeOriginal
 * @property {number} sizeMinified
 * @property {string} [error]
 */

/**
 * @typedef {Object} ResultMinification
 * @property {ResultMinificationFile[]} files
 * @property {number} saved
 */

/** @type {Map<string, Promise<{ htmlMinify: Function, presetOptions: Record<string, unknown> }>>} */
const minifierCache = new Map();

/**
 * Load HTML Minifier Next and resolve preset and extra options into a merged options object.
 * The import and preset resolution are cached per preset name.
 * @param {string} preset
 * @param {Record<string, unknown>} options
 * @returns {Promise<{ htmlMinify: Function, resolvedOptions: Record<string, unknown> }>}
 */
async function loadMinifier(preset, options) {
  if (!minifierCache.has(preset)) {
    minifierCache.set(preset, (async () => {
      let htmlMinify, getPreset;
      try {
        ({ minify: htmlMinify, getPreset } = await import('html-minifier-next'));
      } catch {
        throw new Error('Could not load HTML Minifier Next. Ensure it is installed and check for breaking API changes.');
      }
      let presetOptions;
      try {
        presetOptions = /** @type {Record<string, unknown>} */ (getPreset(preset) ?? {});
      } catch (err) {
        throw new Error(`HTML Minifier Next API error—the package may have breaking changes: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      return { htmlMinify, presetOptions };
    })());
  }
  const { htmlMinify, presetOptions } = await /** @type {Promise<{ htmlMinify: Function, presetOptions: Record<string, unknown> }>} */ (minifierCache.get(preset));
  return { htmlMinify, resolvedOptions: { ...presetOptions, ...options } };
}

/**
 * Minify an HTML string using HTML Minifier Next.
 * @param {string} content
 * @param {{ preset?: string, options?: Record<string, unknown> }} [opts]
 * @returns {Promise<string>}
 */
export async function minifyString(content, { preset = 'comprehensive', options = {} } = {}) {
  const { htmlMinify, resolvedOptions } = await loadMinifier(preset, options);
  return htmlMinify(content, resolvedOptions);
}

/**
 * Minify HTML files using HTML Minifier Next.
 * @param {string[]} filePaths - Input file paths
 * @param {string[]} outputPaths - Output file paths (parallel to filePaths; same value = in-place)
 * @param {{ preset?: string, options?: Record<string, unknown>, concurrency?: number, contents?: Map<string, string>, onProgress?: () => void }} [opts]
 * @returns {Promise<ResultMinification>}
 */
export async function minify(filePaths, outputPaths, { preset = 'comprehensive', options = {}, concurrency = DEFAULT_CONCURRENCY, contents, onProgress } = {}) {
  const { htmlMinify, resolvedOptions } = await loadMinifier(preset, options);

  if (outputPaths.length !== filePaths.length) {
    throw new Error(`outputPaths length (${outputPaths.length}) must match filePaths length (${filePaths.length})`);
  }

  /** @type {{ filePath: string, outputPath: string }[]} */
  const pairs = filePaths.map((filePath, i) => ({ filePath, outputPath: outputPaths[i] }));

  const files = await runWithConcurrency(pairs, concurrency, async ({ filePath, outputPath }) => {
    let content = contents?.get(filePath);

    if (content === undefined) {
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        onProgress?.();
        return /** @type {ResultMinificationFile} */ ({ path: filePath, sizeOriginal: 0, sizeMinified: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const sizeOriginal = Buffer.byteLength(content, 'utf8');

    let minified;
    try {
      minified = await htmlMinify(content, resolvedOptions);
    } catch (err) {
      onProgress?.();
      return /** @type {ResultMinificationFile} */ ({ path: filePath, sizeOriginal, sizeMinified: 0, error: `Minification error: ${err instanceof Error ? err.message : String(err)}` });
    }

    const sizeMinified = Buffer.byteLength(minified, 'utf8');

    try {
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.promises.writeFile(outputPath, minified, 'utf8');
    } catch (err) {
      onProgress?.();
      return /** @type {ResultMinificationFile} */ ({ path: filePath, sizeOriginal, sizeMinified, error: `Write error: ${err instanceof Error ? err.message : String(err)}` });
    }

    onProgress?.();
    return /** @type {ResultMinificationFile} */ ({ path: filePath, sizeOriginal, sizeMinified });
  });

  const saved = files.reduce((acc, f) => f.error ? acc : acc + Math.max(0, (f.sizeOriginal || 0) - (f.sizeMinified || 0)), 0);
  return { files, saved };
}