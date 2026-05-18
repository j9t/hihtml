import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONCURRENCY, runWithConcurrency } from './concurrency.js';

export const HTML_EXTENSIONS = new Set(['html', 'htm', 'shtml', 'shtm']);
export const EXCLUDED_DIRS = new Set(['node_modules', '.git']);

/**
 * Recursively collect HTML files from a directory.
 * @param {string} dir
 * @param {Set<string>} [extensions]
 * @param {Set<string>} [excludedDirs]
 * @returns {Promise<string[]>}
 */
export async function collect(dir, extensions = HTML_EXTENSIONS, excludedDirs = EXCLUDED_DIRS) {
  const resolved = path.resolve(dir);
  try {
    const stat = await fs.promises.stat(resolved);
    if (stat.isFile()) {
      const ext = path.extname(resolved).slice(1).toLowerCase();
      return extensions.has(ext) ? [resolved] : [];
    }
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return [];
    throw err;
  }
  /** @type {string[]} */
  const results = [];
  let rootCanonical;
  try {
    rootCanonical = await fs.promises.realpath(resolved);
  } catch {
    rootCanonical = resolved;
  }
  await walk(resolved, extensions, excludedDirs, results, rootCanonical);
  return results;
}

/**
 * Read file contents concurrently, returning a Map of absolute path → content.
 * Files that cannot be read are omitted; adapters fall back to reading them
 * individually and record the error in their per-file result.
 * @param {string[]} filePaths
 * @param {{ concurrency?: number, onProgress?: () => void }} [options]
 * @returns {Promise<Map<string, string>>}
 */
export async function read(filePaths, { concurrency = DEFAULT_CONCURRENCY, onProgress } = {}) {
  const entries = await runWithConcurrency(filePaths, concurrency, async (filePath) => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      onProgress?.();
      return /** @type {[string, string] | null} */ ([filePath, content]);
    } catch {
      onProgress?.();
      return null;
    }
  });
  return new Map(/** @type {[string, string][]} */ (entries.filter(e => e !== null)));
}

/**
 * @param {string} dir
 * @param {Set<string>} extensions
 * @param {Set<string>} excludedDirs
 * @param {string[]} results
 * @param {string} [dirRoot]
 */
async function walk(dir, extensions, excludedDirs, results, dirRoot = dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT' || code === 'ENOTDIR') return;
    throw err;
  }

  const subdirs = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      try {
        const real = await fs.promises.realpath(fullPath);
        const rel = path.relative(dirRoot, real);
        const inRoot = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (inRoot) {
          const st = await fs.promises.stat(real);
          if (st.isFile()) {
            const ext = path.extname(entry.name).slice(1).toLowerCase();
            if (extensions.has(ext)) results.push(fullPath);
          }
          // Symlinked directories are skipped even when in root, to prevent cycles
        }
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code !== 'ENOENT' && code !== 'ELOOP' && code !== 'EACCES' && code !== 'EPERM') throw err;
      }
      continue;
    }

    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) {
        subdirs.push(walk(fullPath, extensions, excludedDirs, results, dirRoot));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (extensions.has(ext)) results.push(fullPath);
    }
  }
  await Promise.all(subdirs);
}
