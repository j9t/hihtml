#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { styleText } from 'node:util';
import { Command } from 'commander';

import { checkCode } from '../src/adapters/check-code.js';
import { checkLinks } from '../src/adapters/check-links.js';
import { minify } from '../src/adapters/minify.js';
import { collect, read, HTML_EXTENSIONS, EXCLUDED_DIRS } from '../src/lib/files.js';
import { DEFAULT_CONCURRENCY } from '../src/lib/concurrency.js';
import { loadConfig } from '../src/lib/config.js';
import { formatValidationResult, formatDeprecationResult, formatLinkCheckResult, formatMinificationResult, style } from '../src/lib/output.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const program = new Command();

program
  .name('hihtml')
  .version(pkg.version, '-v, --version')
  .description(pkg.description)
  .option('-c, --check-code', 'check HTML code: validate and check for deprecated markup (default when no mode given)')
  .option('-l, --check-links', 'check all external http/https URLs for broken references')
  .option('-m, --minify', 'minify HTML files (in-place unless `--output` is set)')
  .option('-a, --all', 'check HTML code and links, then minify if no validation errors (built-in conformance gate—different from using all individual flags together)')
  .option('-i, --input <dir>', 'input directory', '.')
  .option('-o, --output <dir>', 'output directory for minification (default: same as input)')
  .option('-s, --settings <file>', 'load configuration from a specific JSON file (overrides CWD config lookup)')
  .option('-r, --report [file]', 'save JSON report (default filename: hihtml-report.json)')
  .option('-q, --quiet', 'suppress output when no issues are found')
  .addHelpText('after', `
Examples:
  npx hihtml                   Check current directory for HTML code issues (validate and check for deprecated markup)
  npx hihtml -c                Same as above
  npx hihtml -l                Check all external http/https URLs for broken references
  npx hihtml -c -l             Check HTML code and links
  npx hihtml -m                Minify current directory in-place
  npx hihtml -a                Validate, check, check links, then minify if no validation errors
  npx hihtml -i src -o dist    Minify src/ into dist/
  npx hihtml -s ~/my.json      Use a specific settings file
  npx hihtml -r                Save report to hihtml-report.json
  npx hihtml -r results.json   Save report to results.json
  npx hihtml -q                Run quietly (no output when clean)`);

program.parse(process.argv);

const opts = program.opts();

const isDefault = !opts.all && !opts.checkCode && !opts.minify && !opts.checkLinks;
if (isDefault) opts.checkCode = true;

/**
 * Returns progress controls that write a live counter to STDERR in TTY mode.
 * Call `tick()` per item processed; call `complete(hasIssues)` when done to set the final dot color.
 * @param {string} label
 * @param {number} total
 * @param {{ leadingNewline?: boolean }} [opts]
 * @returns {{ tick: () => void, complete: (hasIssues?: boolean) => void }}
 */
function makeProgress(label, total, { leadingNewline = false } = {}) {
  if (!process.stderr.isTTY || total === 0) return { tick: () => {}, complete: () => {} };
  let done = 0;
  let visible = true;
  const dot = () => visible ? styleText('blue', '●') : ' ';
  process.stderr.write(`${leadingNewline ? '\n' : ''}${label}: 0/${total} ${dot()}`);
  const timer = setInterval(() => {
    visible = !visible;
    process.stderr.write(`\r${label}: ${done}/${total} ${dot()}`);
  }, 500);
  const tick = () => {
    done++;
    process.stderr.write(`\r${label}: ${done}/${total} ${dot()}`);
  };
  const complete = (hasIssues = false) => {
    clearInterval(timer);
    process.stderr.write(`\r${label}: ${total}/${total} ${hasIssues ? styleText('yellow', '●') : styleText('green', '●')}\n`);
  };
  return { tick, complete };
}

(async () => {
  try {
    const config = await loadConfig(process.cwd(), opts.settings);
    const inputDir = path.resolve(opts.input);
    const outputDir = opts.output ? path.resolve(opts.output) : null;

    const extensions = config.extensions
      ? new Set(config.extensions.map(e => String(e).replace(/^\./, '').toLowerCase()))
      : HTML_EXTENSIONS;
    const excludedDir = config.ignore
      ? new Set(config.ignore.map(e => String(e).trim()))
      : EXCLUDED_DIRS;

    const files = await collect(inputDir, extensions, excludedDir);

    if (files.length === 0) {
      console.log(`No HTML files found in ${styleText('bold', inputDir)}`);
      process.exit(0);
    }

    if (isDefault && !opts.quiet) {
      console.log(`Checking ${styleText('bold', inputDir)} for HTML code issues. Use \`-a\` to also check links and minify, or \`-h\` for all options.`);
    }

    const commandParts = [];
    if (opts.all) {
      commandParts.push('all');
    } else {
      if (opts.checkCode)  commandParts.push('check-code');
      if (opts.minify)     commandParts.push('minify');
      if (opts.checkLinks) commandParts.push('check-links');
    }

    const report = {
      timestamp: new Date().toISOString(),
      command: commandParts.join('+') || 'check-code',
      input: inputDir,
      results: {},
    };

    // Read files once when any content-reading mode needs them
    /** @type {Map<string, string> | undefined} */
    let contents;
    if (opts.checkCode || opts.all || opts.checkLinks) {
      const readProg = makeProgress('Reading', files.length);
      contents = await read(files, { concurrency: DEFAULT_CONCURRENCY, onProgress: readProg.tick });
      readProg.complete();
    }

    let quietHadOutput = false;
    const showQuietHint = () => {
      if (opts.quiet && quietHadOutput) console.log('\n(Use `-r` for a full report, or run without `-q` for inline output.)');
    };

    /** @type {import('../src/adapters/check-code.js').CheckResult | undefined} */
    let checkResult;
    if (opts.checkCode || opts.all) {
      const validatePreset = config.validation?.preset ?? 'standard';
      const validateIgnore = config.validation?.ignore ?? [];
      const validateProg = makeProgress('Validating', files.length, { leadingNewline: true });
      checkResult = await checkCode(files, { preset: validatePreset, ignore: validateIgnore, contents, onProgress: validateProg.tick });
      validateProg.complete(
        checkResult.validation.countErrors > 0
        || checkResult.validation.countWarnings > 0
        || checkResult.deprecation.countIssues > 0
      );

      const valOut = formatValidationResult(checkResult.validation, opts.quiet);
      if (valOut) { console.log('\n' + valOut); quietHadOutput = true; }
      const depOut = formatDeprecationResult(checkResult.deprecation, opts.quiet);
      if (depOut) { console.log('\n' + depOut); quietHadOutput = true; }

      report.results.checkCode = checkResult;
    }

    if (opts.checkLinks || opts.all) {
      let linkProg = { tick: () => {}, complete: () => {} };
      const linkResult = await checkLinks(files, {
        timeout: config.links?.timeout,
        concurrency: config.links?.concurrency,
        warnOnPermanentRedirects: config.links?.warnOnPermanentRedirects,
        ignore: config.links?.ignore,
        contents,
        onStart: (total) => { linkProg = makeProgress('Checking links', total, { leadingNewline: true }); },
        onProgress: ()      => linkProg.tick(),
      });
      linkProg.complete(
        linkResult.countBroken > 0
        || linkResult.countFileErrors > 0
        || linkResult.files.some(f => f.links.some(l => l.warning === 'permanent-redirect'))
      );

      const linkOut = formatLinkCheckResult(linkResult, opts.quiet);
      if (linkOut) { console.log('\n' + linkOut); quietHadOutput = true; }
      report.results.links = linkResult;
    }

    if (opts.all && checkResult?.validation.countErrors > 0) {
      console.error(
        '\n' + style.error(`${checkResult.validation.countErrors} validation ${checkResult.validation.countErrors === 1 ? 'error' : 'errors'} found—skipping minification`) + '\n' +
        '(Fix validation issues first or define HTML-validate rule IDs to ignore)'
      );
      showQuietHint();
      if (opts.report !== undefined) await saveReport(report, opts.report);
      process.exit(1);
    }

    if (opts.minify || opts.all) {
      const inPlace = !outputDir;
      const outPaths = inPlace
        ? files
        : files.map(f => {
            const rel = path.relative(inputDir, f);
            return path.join(outputDir, rel || path.basename(f));
          });

      if (inPlace) {
        const confirmed = await confirmInPlace(inputDir);
        if (!confirmed) {
          console.error(style.error('\nMinification aborted'));
          process.exit(0);
        }
      }

      // For `--minify` alone, contents is undefined and minify reads files itself
      const minifyPreset = config.minification?.preset  ?? 'comprehensive';
      const minifyOpts = config.minification?.options ?? {};
      const minifyProg = makeProgress('Minifying', files.length, { leadingNewline: true });
      const minifyResult = await minify(files, outPaths, {
        preset: minifyPreset,
        options: minifyOpts,
        contents,
        onProgress: minifyProg.tick,
      });
      minifyProg.complete(minifyResult.files.some(f => f.error));

      const minOut = formatMinificationResult(minifyResult, opts.quiet);
      if (minOut) { console.log('\n' + minOut); quietHadOutput = true; }
      report.results.minify = minifyResult;
    }

    if (opts.report !== undefined) await saveReport(report, opts.report);

    const hasErrors = (report.results.checkCode?.validation.countErrors ?? 0) > 0
      || (report.results.links?.countBroken ?? 0) > 0
      || (report.results.links?.countFileErrors ?? 0) > 0
      || (report.results.minify?.files.some(f => f.error) ?? false);

    showQuietHint();
    process.exit(hasErrors ? 1 : 0);

  } catch (err) {
    if (process.stderr.isTTY) process.stderr.write('\n');
    console.error(style.error(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(2);
  }
})();

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function confirmInPlace(dir) {
  process.stderr.write(
    '\n' + style.warning(`Minification will modify all HTML files in ${styleText('bold', dir)} in-place.`) + '\n' +
    'If you want to be able to revert, use version control.\n\n' +
    'Continue? [y/N] '
  );

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: null });
    rl.once('line', (line) => { resolve(line.trim().toLowerCase() === 'y'); rl.close(); });
    rl.once('close', () => resolve(false));
  });
}

/**
 * @param {object} report
 * @param {string | boolean} fileOpt
 */
async function saveReport(report, fileOpt) {
  const reportPath = typeof fileOpt === 'string' ? fileOpt : 'hihtml-report.json';
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport saved to ${styleText('bold', reportPath)}`);
}