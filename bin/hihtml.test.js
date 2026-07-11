import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { stripVTControlCharacters } from 'node:util';

import { validate } from '../src/adapters/validate.js';
import { checkCode, checkCodeString } from '../src/adapters/check-code.js';
import { checkLinks, checkLinksString } from '../src/adapters/check-links.js';
import { minify, minifyString } from '../src/adapters/minify.js';
import { collect, read } from '../src/lib/files.js';
import { loadConfig } from '../src/lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'hihtml.js');
const tempDir = path.join(__dirname, 'temp_test');

function run(args, stdinInput = '', cwd = undefined) {
  const result = spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf-8',
    input: stdinInput,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return {
    stdout: stripVTControlCharacters(result.stdout),
    stderr: stripVTControlCharacters(result.stderr),
    status: result.status,
  };
}

// Fixtures

const HTML_CLEAN = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Test</title></head><body><p>Yes</p></body></html>';
const HTML_DEPRECATED = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Test</title></head><body><center>Not anymore</center></body></html>';
const HTML_INVALID = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Test</title></head><body><p><div>No</div></p></body></html>';

/** @type {http.Server} */
let testServer;
/** @type {number} */
let testServerPort;
/** @type {string} */
let testServerBase;

before(async () => {
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'clean.html'), HTML_CLEAN);
  fs.writeFileSync(path.join(tempDir, 'deprecated.html'), HTML_DEPRECATED);
  fs.writeFileSync(path.join(tempDir, 'invalid.html'), HTML_INVALID);

  testServer = await new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1`);
      switch (url.pathname) {
        case '/ok':
          res.writeHead(200); res.end(); break;
        case '/not-found':
          res.writeHead(404); res.end(); break;
        case '/server-error':
          res.writeHead(500); res.end(); break;
        case '/redirect-perm':
          res.writeHead(301, { Location: `http://127.0.0.1:${server.address().port}/ok` }); res.end(); break;
        case '/redirect-temp':
          res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/ok` }); res.end(); break;
        case '/redirect-perm-broken':
          res.writeHead(301, { Location: `http://127.0.0.1:${server.address().port}/not-found` }); res.end(); break;
        case '/head-not-allowed':
          if (req.method === 'HEAD') { res.writeHead(405); res.end(); }
          else { res.writeHead(200); res.end(); }
          break;
        case "/you_aren't_gonna_need_it":
          res.writeHead(200); res.end(); break;
        case '/slow':
          setTimeout(() => { res.writeHead(200); res.end(); }, 2000); break;
        default:
          res.writeHead(404); res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

  testServerPort = /** @type {import('node:net').AddressInfo} */ (testServer.address()).port;
  testServerBase = `http://127.0.0.1:${testServerPort}`;

  fs.writeFileSync(path.join(tempDir, 'links_ok.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/ok">OK</a></body></html>`);
  fs.writeFileSync(path.join(tempDir, 'links_broken.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/not-found">Broken</a></body></html>`);
  fs.writeFileSync(path.join(tempDir, 'links_mixed.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/ok">OK</a><a href="${testServerBase}/not-found">Broken</a></body></html>`);
  fs.writeFileSync(path.join(tempDir, 'links_none.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="/relative">Relative</a><a href="mailto:test@example.com">Mail</a></body></html>`);
  fs.writeFileSync(path.join(tempDir, 'links_redirect_perm.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/redirect-perm">Redirect</a></body></html>`);
  fs.writeFileSync(path.join(tempDir, 'links_500.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/server-error">Error</a></body></html>`);
  fs.writeFileSync(path.join(tempDir, 'links_head_not_allowed.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/head-not-allowed">GET only</a></body></html>`);

  fs.writeFileSync(path.join(tempDir, 'links_apostrophe.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/you_aren't_gonna_need_it">Link</a></body></html>`);

  // CLI-safe fixture: contains a URL on a closed port so the OS refuses it instantly
  // (`spawnSync` blocks the parent event loop, so we can’t use the live test server in CLI tests)
  fs.writeFileSync(path.join(tempDir, 'links_refused.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="http://127.0.0.1:1/broken">Broken</a></body></html>`);
});

after(async () => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  await new Promise(resolve => testServer.close(resolve));
});

// CLI: Basic flags

describe('CLI flags', () => {
  test('`--version` prints a version number', () => {
    const { stdout, status } = run(['-v']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+(-[\w.]+)?$/);
    assert.strictEqual(status, 0);
  });

  test('`--help` prints usage', () => {
    const { stdout, status } = run(['-h']);
    assert.ok(stdout.includes('hihtml'));
    assert.ok(stdout.includes('--check-code'));
    assert.ok(stdout.includes('--minify'));
    assert.strictEqual(status, 0);
  });

  test('`-c -m` runs check and minify', () => {
    const outDir = path.join(tempDir, 'cm_out');
    const { stdout, status } = run(['-c', '-m', '-i', path.join(tempDir, 'clean.html'), '-o', outDir]);
    assert.ok(stdout.includes('Validation'));
    assert.ok(stdout.includes('Minification'));
    assert.strictEqual(status, 0);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('`-c -l -m` runs all three without validation gate', () => {
    const outDir = path.join(tempDir, 'clm_out');
    const { stdout, status } = run(['-c', '-l', '-m', '-i', path.join(tempDir, 'links_none.html'), '-o', outDir]);
    assert.ok(stdout.includes('Validation'));
    assert.ok(stdout.includes('Links'));
    assert.ok(stdout.includes('Minification'));
    assert.strictEqual(status, 0);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('`--all` combined with other mode flags runs as `--all`', () => {
    const outDir = path.join(tempDir, 'all_c_out');
    const { stdout, status } = run(['-a', '-c', '-i', path.join(tempDir, 'links_none.html'), '-o', outDir]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes('Validation'));
    assert.ok(stdout.includes('Links'));
    assert.ok(stdout.includes('Minification'));
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('Default mode shows preamble', () => {
    const { stdout } = run(['-i', path.join(tempDir, 'clean.html')]);
    assert.ok(stdout.includes('HTML code issues'));
    assert.ok(stdout.includes('-a'));
    assert.ok(stdout.includes('-h'));
  });

  test('Explicit `-c` does not show preamble', () => {
    const { stdout } = run(['-c', '-i', path.join(tempDir, 'clean.html')]);
    assert.ok(!stdout.includes('HTML code issues'));
  });
});

// CLI: Check code (validate)

describe('CLI `--check-code`', () => {
  test('Exits “0” when no HTML files are found', () => {
    const emptyDir = path.join(tempDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const { status } = run(['-c', '-i', emptyDir]);
    assert.strictEqual(status, 0);
    fs.rmdirSync(emptyDir);
  });

  test('Reports “Validation” section', () => {
    const { stdout } = run(['-c', '-i', path.join(tempDir, 'clean.html')]);
    assert.ok(stdout.includes('Validation'));
  });

  test('Reports “Deprecated markup” section', () => {
    const { stdout } = run(['-c', '-i', path.join(tempDir, 'clean.html')]);
    assert.ok(stdout.includes('Deprecated'));
  });

  test('Detects deprecated `<center>` element', () => {
    const { stdout } = run(['-c', '-i', path.join(tempDir, 'deprecated.html')]);
    assert.ok(stdout.includes('center'));
  });

  test('Exits “1” when deprecated markup is found', () => {
    const { status } = run(['-c', '-i', path.join(tempDir, 'deprecated.html')]);
    assert.strictEqual(status, 1);
  });

  test('Exits “1” when validation errors are found', () => {
    const { status } = run(['-c', '-i', path.join(tempDir, 'invalid.html')]);
    assert.strictEqual(status, 1);
  });

  test('Exits “0” for clean HTML', () => {
    const { status } = run(['-c', '-i', path.join(tempDir, 'clean.html')]);
    assert.strictEqual(status, 0);
  });

  test('No args defaults to `--check-code` behavior', () => {
    const { stdout } = run(['-i', path.join(tempDir, 'clean.html')]);
    assert.ok(stdout.includes('Validation'));
  });

  test('Numbers sections when multiple are shown', () => {
    const { stdout } = run(['-c', '-i', path.join(tempDir, 'clean.html')]);
    assert.ok(stdout.includes('1. '));
    assert.ok(stdout.includes('2. '));
  });
});

// CLI: Check links
// Note: Most CLI tests use fixtures without http/https links (links_none.html) or with
// a URL on a closed port (links_refused.html, port 1 → instant ECONNREFUSED) to avoid
// blocking the parent event loop via `spawnSync`; actual HTTP behavior is tested via the
// programmatic API above

describe('CLI `--check-links`', () => {
  test('Reports "Links" section', () => {
    const { stdout } = run(['-l', '-i', path.join(tempDir, 'links_none.html')]);
    assert.ok(stdout.includes('Links'));
  });

  test('Reports "no broken links" when no http/https links are found', () => {
    const { stdout } = run(['-l', '-i', path.join(tempDir, 'links_none.html')]);
    assert.ok(stdout.includes('no broken links'));
  });

  test('Reports broken links', () => {
    const { stdout } = run(['-l', '-i', path.join(tempDir, 'links_refused.html')]);
    assert.ok(stdout.includes('broken') || stdout.includes('1'));
  });

  test('Exits “1” with broken links', () => {
    const { status } = run(['-l', '-i', path.join(tempDir, 'links_refused.html')]);
    assert.strictEqual(status, 1);
  });

  test('Exits “0” when broken links are ignored', () => {
    const ignoreDir = path.join(tempDir, 'ignore_test');
    fs.mkdirSync(ignoreDir, { recursive: true });
    fs.writeFileSync(
      path.join(ignoreDir, '.hihtml.json'),
      JSON.stringify({ links: { ignore: ['127.0.0.1'] } })
    );
    fs.writeFileSync(path.join(ignoreDir, 'page.html'),
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="http://127.0.0.1:1/broken">Broken</a></body></html>`
    );
    const { status } = run(['-l', '-i', ignoreDir], '', ignoreDir);
    assert.strictEqual(status, 0);
    fs.rmSync(ignoreDir, { recursive: true, force: true });
  });

  test('`-l` alone does not run markup check', () => {
    const { stdout } = run(['-l', '-i', path.join(tempDir, 'links_none.html')]);
    assert.ok(!stdout.includes('Validation'));
    assert.ok(!stdout.includes('Deprecated'));
  });

  test('`-c -l` runs both markup check and link check', () => {
    const { stdout } = run(['-c', '-l', '-i', path.join(tempDir, 'links_none.html')]);
    assert.ok(stdout.includes('Validation'));
    assert.ok(stdout.includes('Links'));
  });

  test('`--all` includes link check', () => {
    // invalid.html has no http/https links, so link check completes instantly
    const outDir = path.join(tempDir, 'all_links_out');
    const { stdout } = run(['-a', '-i', path.join(tempDir, 'links_none.html'), '-o', outDir]);
    assert.ok(stdout.includes('Links'));
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('`--all` still exits “1” for validation errors (link check does not change gate)', () => {
    // invalid.html has no http/https links, so link check completes quickly before the gate
    const outDir = path.join(tempDir, 'all_links_invalid_out');
    const { status } = run(['-a', '-i', path.join(tempDir, 'invalid.html'), '-o', outDir]);
    assert.strictEqual(status, 1);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('Report includes "links" section when `-l` is set', () => {
    const reportPath = path.join(tempDir, 'links-report.json');
    run(['-l', '-i', path.join(tempDir, 'links_none.html'), '-r', reportPath]);
    assert.ok(fs.existsSync(reportPath));
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.ok('links' in report.results);
    assert.ok('countBroken' in report.results.links);
    assert.ok('countChecked' in report.results.links);
    assert.ok(Array.isArray(report.results.links.files));
    fs.unlinkSync(reportPath);
  });

  test('Report command field reflects flags used', () => {
    const reportPath = path.join(tempDir, 'cmd-report.json');
    run(['-c', '-l', '-i', path.join(tempDir, 'links_none.html'), '-r', reportPath]);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.strictEqual(report.command, 'check-code+check-links');
    fs.unlinkSync(reportPath);
  });

  test('Does not number section when only one check is shown', () => {
    const { stdout } = run(['-l', '-i', path.join(tempDir, 'links_none.html')]);
    assert.ok(!stdout.includes('1. '));
  });
});

// CLI: Minify

describe('CLI `--minify`', () => {
  test('Minifies into output directory', () => {
    const outDir = path.join(tempDir, 'minify_out');
    const { status } = run(['-m', '-i', path.join(tempDir, 'clean.html'), '-o', outDir]);
    assert.strictEqual(status, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'clean.html')));
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('Reports “Minification” section', () => {
    const outDir = path.join(tempDir, 'minify_out2');
    const { stdout } = run(['-m', '-i', path.join(tempDir, 'clean.html'), '-o', outDir]);
    assert.ok(stdout.includes('Minification'));
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('Output file is not larger than input', () => {
    const outDir = path.join(tempDir, 'minify_out3');
    run(['-m', '-i', path.join(tempDir, 'clean.html'), '-o', outDir]);
    const original = fs.statSync(path.join(tempDir, 'clean.html')).size;
    const minified = fs.statSync(path.join(outDir, 'clean.html')).size;
    assert.ok(minified <= original);
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

// CLI: All

describe('CLI `--all`', () => {
  test('Runs check and minify when HTML is clean', () => {
    const outDir = path.join(tempDir, 'all_out');
    const { stdout, status } = run(['-a', '-i', path.join(tempDir, 'clean.html'), '-o', outDir]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes('Validation'));
    assert.ok(stdout.includes('Minification'));
    assert.ok(fs.existsSync(path.join(outDir, 'clean.html')));
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('Skips minification and exits “1” when validation errors are found', () => {
    const outDir = path.join(tempDir, 'all_err_out');
    const { stdout, status } = run(['-a', '-i', path.join(tempDir, 'invalid.html'), '-o', outDir]);
    assert.strictEqual(status, 1);
    assert.ok(!stdout.includes('Minification'));
    assert.ok(!fs.existsSync(path.join(outDir, 'invalid.html')));
  });

  test('Proceeds to minification and exits “0” when all validation errors are ignored via config', async () => {
    const ignoreDir = path.join(tempDir, 'validation_ignore_cli');
    const outDir = path.join(tempDir, 'validation_ignore_cli_out');
    fs.mkdirSync(ignoreDir, { recursive: true });

    const base = await validate([path.join(tempDir, 'invalid.html')]);
    const ruleIds = [...new Set(base.files[0].messages.map(m => m.ruleId))];

    fs.copyFileSync(path.join(tempDir, 'invalid.html'), path.join(ignoreDir, 'page.html'));
    fs.writeFileSync(
      path.join(ignoreDir, '.hihtml.json'),
      JSON.stringify({ validation: { ignore: ruleIds } })
    );

    const { stdout, status } = run(['-a', '-i', ignoreDir, '-o', outDir], '', ignoreDir);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes('Minification'));
    assert.ok(stdout.includes('ignored'));

    fs.rmSync(ignoreDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('Runs check and minify and exits “0” when only deprecated markup is found (no validation errors)', () => {
    // Uses a11y preset (via config) + `<tt>` element: ObsoHTML flags it, html-validate:a11y does not
    const srcDir = path.join(tempDir, 'all_deprecated_src');
    const outDir = path.join(tempDir, 'all_deprecated_out');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'page.html'), '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><tt>mono</tt></body></html>');
    fs.writeFileSync(path.join(srcDir, '.hihtml.json'), JSON.stringify({ validation: { preset: 'a11y' } }));
    const { stdout, status } = run(['-a', '-i', srcDir, '-o', outDir], '', srcDir);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes('Minification'));
    assert.ok(fs.existsSync(path.join(outDir, 'page.html')));
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test('Numbers all sections', () => {
    const outDir = path.join(tempDir, 'all_numbered_out');
    const { stdout } = run(['-a', '-i', path.join(tempDir, 'clean.html'), '-o', outDir]);
    assert.ok(stdout.includes('1. '));
    assert.ok(stdout.includes('2. '));
    assert.ok(stdout.includes('3. '));
    assert.ok(stdout.includes('4. '));
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

// CLI: Report

describe('CLI `--report`', () => {
  const reportPath = path.join(tempDir, 'test-report.json');

  after(() => {
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  });

  test('Saves report to specified path', () => {
    run(['-c', '-i', path.join(tempDir, 'clean.html'), '-r', reportPath]);
    assert.ok(fs.existsSync(reportPath));
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.ok('timestamp' in report);
    assert.ok('results' in report);
  });

  test('Report contains check results', () => {
    run(['-c', '-i', path.join(tempDir, 'clean.html'), '-r', reportPath]);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.ok('checkCode' in report.results);
    assert.ok('validation' in report.results.checkCode);
    assert.ok('deprecation' in report.results.checkCode);
  });

  test('Saves report to default filename when `-r` has no value', () => {
    const defaultReport = path.join(tempDir, 'hihtml-report.json');
    run(['-c', '-i', path.join(tempDir, 'clean.html'), '-r'], '', tempDir);
    assert.ok(fs.existsSync(defaultReport));
    fs.unlinkSync(defaultReport);
  });
});

// CLI: Settings

describe('CLI `--settings`', () => {
  test('Accepts a settings file and runs normally', () => {
    const settingsPath = path.join(tempDir, 'cli-settings-basic.json');
    fs.writeFileSync(settingsPath, JSON.stringify({}));
    const { status } = run(['-c', '-i', path.join(tempDir, 'clean.html'), '-s', settingsPath]);
    assert.strictEqual(status, 0);
    fs.unlinkSync(settingsPath);
  });

  test('Applies config from a standalone settings file', async () => {
    const srcDir = path.join(tempDir, 'cli-settings-src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.copyFileSync(path.join(tempDir, 'invalid.html'), path.join(srcDir, 'page.html'));

    const base    = await validate([path.join(tempDir, 'invalid.html')]);
    const ruleIds = [...new Set(base.files[0].messages.map(m => m.ruleId))];

    const settingsPath = path.join(tempDir, 'cli-settings-ignore.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ validation: { ignore: ruleIds } }));

    const { status } = run(['-c', '-i', srcDir, '-s', settingsPath]);
    assert.strictEqual(status, 0);

    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.unlinkSync(settingsPath);
  });

  test('Reads `hihtml` key from settings file', async () => {
    const srcDir = path.join(tempDir, 'cli-settings-pkg-src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.copyFileSync(path.join(tempDir, 'invalid.html'), path.join(srcDir, 'page.html'));

    const base    = await validate([path.join(tempDir, 'invalid.html')]);
    const ruleIds = [...new Set(base.files[0].messages.map(m => m.ruleId))];

    const settingsPath = path.join(tempDir, 'cli-settings-pkg.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ name: 'my-project', hihtml: { validation: { ignore: ruleIds } } }));

    const { status } = run(['-c', '-i', srcDir, '-s', settingsPath]);
    assert.strictEqual(status, 0);

    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.unlinkSync(settingsPath);
  });

  test('Overrides CWD config when settings file is given', async () => {
    const cwdDir = path.join(tempDir, 'cli-settings-override-cwd');
    fs.mkdirSync(cwdDir, { recursive: true });
    fs.writeFileSync(path.join(cwdDir, '.hihtml.json'), JSON.stringify({}));
    fs.copyFileSync(path.join(tempDir, 'invalid.html'), path.join(cwdDir, 'page.html'));

    const base    = await validate([path.join(tempDir, 'invalid.html')]);
    const ruleIds = [...new Set(base.files[0].messages.map(m => m.ruleId))];

    const settingsPath = path.join(tempDir, 'cli-settings-override.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ validation: { ignore: ruleIds } }));

    const { status: withoutSettings } = run(['-c', '-i', cwdDir], '', cwdDir);
    assert.strictEqual(withoutSettings, 1);

    const { status: withSettings } = run(['-c', '-i', cwdDir, '-s', settingsPath], '', cwdDir);
    assert.strictEqual(withSettings, 0);

    fs.rmSync(cwdDir, { recursive: true, force: true });
    fs.unlinkSync(settingsPath);
  });

  test('Exits "2" when settings file does not exist', () => {
    const { status } = run(['-c', '-i', path.join(tempDir, 'clean.html'), '-s', path.join(tempDir, 'nonexistent.json')]);
    assert.strictEqual(status, 2);
  });
});

// CLI: Quiet mode

describe('CLI `--quiet`', () => {
  test('Produces no STDOUT for clean HTML', () => {
    const { stdout, status } = run(['-q', '-c', '-i', path.join(tempDir, 'clean.html')]);
    assert.strictEqual(stdout.trim(), '');
    assert.strictEqual(status, 0);
  });

  test('Suppresses banner in default (check-code) mode', () => {
    const { stdout } = run(['-q', '-i', path.join(tempDir, 'clean.html')]);
    assert.ok(!stdout.includes('HTML code issues'));
    assert.strictEqual(stdout.trim(), '');
  });

  test('Shows output and exits "1" when validation errors are found', () => {
    const { stdout, status } = run(['-q', '-c', '-i', path.join(tempDir, 'invalid.html')]);
    assert.ok(stdout.trim().length > 0);
    assert.strictEqual(status, 1);
  });

  test('Shows ignored-issue summary when all validation errors are suppressed via ignore list', async () => {
    const base = await validate([path.join(tempDir, 'invalid.html')]);
    const ruleIds = [...new Set(base.files[0].messages.map(m => m.ruleId))];

    const srcDir = path.join(tempDir, 'quiet_ignored_src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.copyFileSync(path.join(tempDir, 'invalid.html'), path.join(srcDir, 'page.html'));
    fs.writeFileSync(path.join(srcDir, '.hihtml.json'), JSON.stringify({ validation: { ignore: ruleIds } }));

    const { stdout, status } = run(['-q', '-c', '-i', srcDir], '', srcDir);
    assert.ok(stdout.includes('ignored'));
    assert.strictEqual(status, 0);

    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  test('Produces no STDOUT for link check with no http/https links', () => {
    const { stdout, status } = run(['-q', '-l', '-i', path.join(tempDir, 'links_none.html')]);
    assert.strictEqual(stdout.trim(), '');
    assert.strictEqual(status, 0);
  });

  test('Shows broken links and exits "1"', () => {
    const { stdout, status } = run(['-q', '-l', '-i', path.join(tempDir, 'links_refused.html')]);
    assert.ok(stdout.trim().length > 0);
    assert.strictEqual(status, 1);
  });

  test('Produces no STDOUT for clean minification', () => {
    const outDir = path.join(tempDir, 'quiet_minify_out');
    const { stdout, status } = run(['-q', '-m', '-i', path.join(tempDir, 'clean.html'), '-o', outDir]);
    assert.strictEqual(stdout.trim(), '');
    assert.strictEqual(status, 0);
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

// Internal adapter: `validate`

describe('Validate files', () => {
  const fileClean = path.join(tempDir, 'clean.html');
  const fileInvalid = path.join(tempDir, 'invalid.html');

  test('Returns expected result shape', async () => {
    const result = await validate([fileClean]);
    assert.ok('files' in result);
    assert.ok('countErrors' in result);
    assert.ok('countWarnings' in result);
    assert.ok(Array.isArray(result.files));
  });

  test('Clean HTML reports no errors', async () => {
    const result = await validate([fileClean]);
    assert.strictEqual(result.countErrors, 0);
  });

  test('Each file result has path and messages', async () => {
    const result = await validate([fileClean]);
    assert.strictEqual(result.files[0].path, fileClean);
    assert.ok(Array.isArray(result.files[0].messages));
  });

  test('Validates multiple files', async () => {
    const result = await validate([fileClean, fileInvalid]);
    assert.strictEqual(result.files.length, 2);
  });

  test('Detects validation errors', async () => {
    const result = await validate([fileInvalid]);
    assert.ok(result.countErrors > 0);
  });

  test('Accepts pre-read contents Map', async () => {
    const contents = await read([fileClean]);
    const result = await validate([fileClean], { contents });
    assert.strictEqual(result.countErrors, 0);
  });

  test('Records error for non-existent file', async () => {
    const missing = path.join(tempDir, 'nonexistent.html');
    const result = await validate([missing]);
    assert.strictEqual(result.files[0].messages.length, 1);
    assert.strictEqual(result.files[0].messages[0].severity, 2);
  });

  test('Returns `countIgnored` in result shape', async () => {
    const result = await validate([fileClean]);
    assert.ok('countIgnored' in result);
    assert.strictEqual(result.countIgnored, 0);
  });

  test('Ignored rule IDs are tagged and not counted as errors', async () => {
    const base = await validate([fileInvalid]);
    const ruleIds = [...new Set(base.files[0].messages.map(m => m.ruleId))];

    const result = await validate([fileInvalid], { ignore: ruleIds });
    assert.strictEqual(result.countErrors, 0);
    assert.strictEqual(result.countIgnored, base.files[0].messages.length);
    assert.ok(result.files[0].messages.every(m => m.ignored === true));
  });

  test('Non-matching ignore list does not suppress errors', async () => {
    const base = await validate([fileInvalid]);
    const result = await validate([fileInvalid], { ignore: ['no-such-rule'] });
    assert.strictEqual(result.countErrors, base.countErrors);
    assert.strictEqual(result.countIgnored, 0);
    assert.ok(result.files[0].messages.every(m => !m.ignored));
  });
});

// Programmatic API: `checkCode`

describe('Check code', () => {
  const fileClean = path.join(tempDir, 'clean.html');
  const fileDeprecated = path.join(tempDir, 'deprecated.html');

  test('Returns expected result shape', async () => {
    const result = await checkCode([fileClean]);
    assert.ok('validation' in result);
    assert.ok('deprecation' in result);
    assert.ok('countErrors' in result.validation);
    assert.ok('countIssues' in result.deprecation);
  });

  test('Clean HTML reports no issues', async () => {
    const result = await checkCode([fileClean]);
    assert.strictEqual(result.validation.countErrors, 0);
    assert.strictEqual(result.deprecation.countIssues, 0);
    assert.deepStrictEqual(result.deprecation.files[0].elements, []);
    assert.deepStrictEqual(result.deprecation.files[0].attributes, []);
  });

  test('Detects deprecated `<center>` element', async () => {
    const result = await checkCode([fileDeprecated]);
    assert.ok(result.deprecation.countIssues > 0);
    assert.ok(result.deprecation.files[0].elements.includes('center'));
  });

  test('Accepts pre-read contents Map', async () => {
    const contents = await read([fileClean]);
    const result = await checkCode([fileClean], { contents });
    assert.strictEqual(result.deprecation.countIssues, 0);
  });

  test('Passes ignore list through to validation result', async () => {
    const fileInvalid = path.join(tempDir, 'invalid.html');
    const base = await checkCode([fileInvalid]);
    const ruleIds = [...new Set(base.validation.files[0].messages.map(m => m.ruleId))];

    const result = await checkCode([fileInvalid], { ignore: ruleIds });
    assert.strictEqual(result.validation.countErrors, 0);
    assert.strictEqual(result.validation.countIgnored, base.validation.files[0].messages.length);
  });
});

// Programmatic API: `checkCodeString`

describe('Check code string', () => {
  test('Returns expected result shape', async () => {
    const result = await checkCodeString(HTML_CLEAN);
    assert.ok('validation' in result);
    assert.ok('deprecation' in result);
    assert.ok('countErrors' in result.validation);
    assert.ok('countIssues' in result.deprecation);
  });

  test('Clean HTML reports no issues', async () => {
    const result = await checkCodeString(HTML_CLEAN);
    assert.strictEqual(result.validation.countErrors, 0);
    assert.strictEqual(result.deprecation.countIssues, 0);
  });

  test('Detects deprecated markup', async () => {
    const result = await checkCodeString(HTML_DEPRECATED);
    assert.ok(result.deprecation.countIssues > 0);
    assert.ok(result.deprecation.files[0].elements.includes('center'));
  });

  test('Detects validation errors', async () => {
    const result = await checkCodeString(HTML_INVALID);
    assert.ok(result.validation.countErrors > 0);
  });

  test('Passes ignore list through to validation result', async () => {
    const base = await checkCodeString(HTML_INVALID);
    const ruleIds = [...new Set(base.validation.files[0].messages.map(m => m.ruleId))];
    const result = await checkCodeString(HTML_INVALID, { ignore: ruleIds });
    assert.strictEqual(result.validation.countErrors, 0);
    assert.strictEqual(result.validation.countIgnored, base.validation.files[0].messages.length);
  });
});

// Programmatic API: `checkLinks`

describe('Check links', () => {
  test('Returns expected result shape', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_ok.html')]);
    assert.ok('files' in result);
    assert.ok('countBroken' in result);
    assert.ok('countChecked' in result);
    assert.ok(Array.isArray(result.files));
  });

  test('Reports ok for 200 response', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_ok.html')]);
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.countChecked, 1);
    assert.strictEqual(result.files[0].links[0].ok, true);
    assert.strictEqual(result.files[0].links[0].status, 200);
  });

  test('Reports broken for 404 response', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_broken.html')]);
    assert.strictEqual(result.countBroken, 1);
    assert.strictEqual(result.files[0].links[0].ok, false);
    assert.strictEqual(result.files[0].links[0].status, 404);
  });

  test('Reports broken for 500 response', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_500.html')]);
    assert.strictEqual(result.countBroken, 1);
    assert.strictEqual(result.files[0].links[0].ok, false);
    assert.strictEqual(result.files[0].links[0].status, 500);
  });

  test('Follows redirects and reports final status', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_redirect_perm.html')]);
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.files[0].links[0].ok, true);
    assert.strictEqual(result.files[0].links[0].status, 200);
  });

  test('Falls back from HEAD to GET on 405', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_head_not_allowed.html')]);
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.files[0].links[0].ok, true);
    assert.strictEqual(result.files[0].links[0].status, 200);
  });

  test('Ignores relative and non-http links', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_none.html')]);
    assert.strictEqual(result.countChecked, 0);
    assert.strictEqual(result.files[0].links.length, 0);
  });

  test('Deduplicates URLs across files', async () => {
    const result = await checkLinks([
      path.join(tempDir, 'links_ok.html'),
      path.join(tempDir, 'links_ok.html'),
    ]);
    assert.strictEqual(result.countChecked, 1);
    assert.strictEqual(result.files.length, 2);
    assert.strictEqual(result.files[0].links[0].url, result.files[1].links[0].url);
  });

  test('Reports mixed results per file', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_mixed.html')]);
    assert.strictEqual(result.files[0].links.length, 2);
    assert.strictEqual(result.files[0].countBroken, 1);
    assert.strictEqual(result.countChecked, 2);
    assert.strictEqual(result.countBroken, 1);
  });

  test('Warns on permanent redirect when warnOnPermanentRedirects is set', async () => {
    const result = await checkLinks(
      [path.join(tempDir, 'links_redirect_perm.html')],
      { warnOnPermanentRedirects: true }
    );
    assert.strictEqual(result.files[0].links[0].warning, 'permanent-redirect');
    assert.strictEqual(result.files[0].links[0].ok, true);
  });

  test('Does not warn on permanent redirect by default', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_redirect_perm.html')]);
    assert.strictEqual(result.files[0].links[0].warning, undefined);
  });

  test('Handles timeout', async () => {
    const slowFile = path.join(tempDir, 'links_slow.html');
    fs.writeFileSync(slowFile,
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/slow">Slow</a></body></html>`);
    const result = await checkLinks([slowFile], { timeout: 100 });
    assert.strictEqual(result.files[0].links[0].error, 'Timeout');
    assert.strictEqual(result.files[0].links[0].ok, false);
    fs.unlinkSync(slowFile);
  });

  test('Accepts pre-read contents Map', async () => {
    const filePath = path.join(tempDir, 'links_ok.html');
    const contents = await read([filePath]);
    const result = await checkLinks([filePath], { contents });
    assert.strictEqual(result.countChecked, 1);
    assert.strictEqual(result.files[0].links[0].ok, true);
  });

  test('Skips URLs matching ignore hostname', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_broken.html')], {
      ignore: ['127.0.0.1'],
    });
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.countSkipped, 1);
    assert.strictEqual(result.countChecked, 0);
    assert.strictEqual(result.files[0].links[0].skipped, true);
    assert.strictEqual(result.files[0].links[0].ok, true);
  });

  test('Skips URLs matching ignore URL prefix', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_broken.html')], {
      ignore: [`${testServerBase}/not-found`],
    });
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.countSkipped, 1);
  });

  test('Does not count ignored URLs as broken', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_mixed.html')], {
      ignore: ['127.0.0.1'],
    });
    assert.strictEqual(result.countChecked, 0);
    assert.strictEqual(result.countSkipped, 2);
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.files[0].countBroken, 0);
  });

  test('`countSkipped` is 0 when no ignore list given', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_ok.html')]);
    assert.strictEqual(result.countSkipped, 0);
  });

  test('Extracts full URL when apostrophe appears in double-quoted href', async () => {
    const result = await checkLinks([path.join(tempDir, 'links_apostrophe.html')]);
    assert.strictEqual(result.countChecked, 1);
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.files[0].links[0].ok, true);
  });
});

// Programmatic API: `checkLinksString`

describe('Check links string', () => {
  test('Returns expected result shape', async () => {
    const result = await checkLinksString(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/ok">OK</a></body></html>`);
    assert.ok('files' in result);
    assert.ok('countBroken' in result);
    assert.ok('countChecked' in result);
    assert.ok(Array.isArray(result.files));
  });

  test('Reports ok for 200 response', async () => {
    const result = await checkLinksString(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/ok">OK</a></body></html>`);
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.countChecked, 1);
    assert.strictEqual(result.files[0].links[0].ok, true);
  });

  test('Reports broken for 404 response', async () => {
    const result = await checkLinksString(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><a href="${testServerBase}/not-found">Broken</a></body></html>`);
    assert.strictEqual(result.countBroken, 1);
    assert.strictEqual(result.files[0].links[0].ok, false);
  });

  test('No http/https links returns empty result', async () => {
    const result = await checkLinksString(HTML_CLEAN);
    assert.strictEqual(result.countBroken, 0);
    assert.strictEqual(result.countChecked, 0);
    assert.strictEqual(result.files[0].links.length, 0);
  });
});

// Programmatic API: URL extraction (attributes and quote styles)

describe('URL extraction', () => {
  const ok = () => `${testServerBase}/ok`;
  const found = async (html) => {
    const r = await checkLinksString(html);
    return { checked: r.countChecked, broken: r.countBroken };
  };

  test('`href` double-quoted', async () => {
    assert.deepStrictEqual(await found(`<a href="${ok()}">L</a>`), { checked: 1, broken: 0 });
  });

  test('`href` single-quoted', async () => {
    assert.deepStrictEqual(await found(`<a href='${ok()}'>L</a>`), { checked: 1, broken: 0 });
  });

  test('`href` unquoted', async () => {
    assert.deepStrictEqual(await found(`<a href=${ok()}>L</a>`), { checked: 1, broken: 0 });
  });

  test('`src` double-quoted', async () => {
    assert.deepStrictEqual(await found(`<img src="${ok()}">`), { checked: 1, broken: 0 });
  });

  test('`src` single-quoted', async () => {
    assert.deepStrictEqual(await found(`<img src='${ok()}'>`), { checked: 1, broken: 0 });
  });

  test('`src` unquoted', async () => {
    assert.deepStrictEqual(await found(`<img src=${ok()}>`), { checked: 1, broken: 0 });
  });

  test('`action` double-quoted', async () => {
    assert.deepStrictEqual(await found(`<form action="${ok()}"></form>`), { checked: 1, broken: 0 });
  });

  test('`action` single-quoted', async () => {
    assert.deepStrictEqual(await found(`<form action='${ok()}'></form>`), { checked: 1, broken: 0 });
  });

  test('`action` unquoted', async () => {
    assert.deepStrictEqual(await found(`<form action=${ok()}></form>`), { checked: 1, broken: 0 });
  });

  test('`srcset` double-quoted', async () => {
    assert.deepStrictEqual(await found(`<img srcset="${ok()} 2x">`), { checked: 1, broken: 0 });
  });

  test('`srcset` single-quoted', async () => {
    assert.deepStrictEqual(await found(`<img srcset='${ok()} 2x'>`), { checked: 1, broken: 0 });
  });

  test('`href` with spaces around `=`', async () => {
    assert.deepStrictEqual(await found(`<a href = "${ok()}">link</a>`), { checked: 1, broken: 0 });
  });

  test('`srcset` with spaces around `=`', async () => {
    assert.deepStrictEqual(await found(`<img srcset = "${ok()} 2x">`), { checked: 1, broken: 0 });
  });

  test('Does not check URLs inside HTML comments', async () => {
    assert.deepStrictEqual(await found(`<!-- <a href="${ok()}">ignored</a> -->`), { checked: 0, broken: 0 });
  });

  test('Does not check URLs inside `<script>` body', async () => {
    assert.deepStrictEqual(await found(`<script>var u = "${ok()}";</script>`), { checked: 0, broken: 0 });
  });

  test('Still checks `<script src>`', async () => {
    assert.deepStrictEqual(await found(`<script src="${ok()}"></script>`), { checked: 1, broken: 0 });
  });

  test('Does not check URLs inside `<style>` body', async () => {
    assert.deepStrictEqual(await found(`<style>a::before { content: "${ok()}"; }</style>`), { checked: 0, broken: 0 });
  });
});

// Programmatic API: `minify`

describe('Minify files', () => {
  const fileClean = path.join(tempDir, 'clean.html');

  test('Returns expected result shape', async () => {
    const outPath = path.join(tempDir, 'minify_api_out.html');
    const result = await minify([fileClean], [outPath]);
    assert.ok('files' in result);
    assert.ok('saved' in result);
    assert.ok(Array.isArray(result.files));
    fs.unlinkSync(outPath);
  });

  test('Output file is not larger than input', async () => {
    const outPath = path.join(tempDir, 'minify_size_out.html');
    const result = await minify([fileClean], [outPath]);
    assert.ok(result.files[0].sizeOriginal >= result.files[0].sizeMinified);
    fs.unlinkSync(outPath);
  });

  test('Writes output file', async () => {
    const outPath = path.join(tempDir, 'minify_write_out.html');
    await minify([fileClean], [outPath]);
    assert.ok(fs.existsSync(outPath));
    fs.unlinkSync(outPath);
  });

  test('`saved` reflects bytes reduced', async () => {
    const outPath = path.join(tempDir, 'minify_saved_out.html');
    const result = await minify([fileClean], [outPath]);
    const expected = Math.max(0, result.files[0].sizeOriginal - result.files[0].sizeMinified);
    assert.strictEqual(result.saved, expected);
    fs.unlinkSync(outPath);
  });

  test('Accepts pre-read contents Map', async () => {
    const outPath = path.join(tempDir, 'minify_contents_out.html');
    const contents = await read([fileClean]);
    const result = await minify([fileClean], [outPath], { contents });
    assert.ok(!result.files[0].error);
    fs.unlinkSync(outPath);
  });

  test('Records error for non-existent input file', async () => {
    const missing = path.join(tempDir, 'nonexistent.html');
    const outPath = path.join(tempDir, 'nonexistent_out.html');
    const result = await minify([missing], [outPath]);
    assert.ok(typeof result.files[0].error === 'string');
    assert.ok(!fs.existsSync(outPath));
  });

  test('Preset collapses whitespace by default', async () => {
    const filePath = path.join(tempDir, 'whitespace.html');
    const outPath = path.join(tempDir, 'whitespace_preset_out.html');
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Test</title></head><body><p>  Hello   world  </p></body></html>';
    const contents = new Map([[filePath, html]]);
    await minify([filePath], [outPath], { contents });
    const result = fs.readFileSync(outPath, 'utf8');
    assert.ok(!result.includes('  Hello'), 'Expected whitespace to be collapsed by the comprehensive preset');
    fs.unlinkSync(outPath);
  });

  test('Overriding `collapseWhitespace: false` preserves whitespace', async () => {
    const filePath = path.join(tempDir, 'whitespace.html');
    const outPath = path.join(tempDir, 'whitespace_override_out.html');
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Test</title></head><body><p>  Hello   world  </p></body></html>';
    const contents = new Map([[filePath, html]]);
    await minify([filePath], [outPath], { contents, options: { collapseWhitespace: false } });
    const result = fs.readFileSync(outPath, 'utf8');
    assert.ok(result.includes('  Hello'), 'Expected whitespace to be preserved when collapseWhitespace is overridden to false');
    fs.unlinkSync(outPath);
  });
});

// Programmatic API: `minifyString`

describe('Minify string', () => {
  test('Returns a string', async () => {
    const result = await minifyString(HTML_CLEAN);
    assert.strictEqual(typeof result, 'string');
  });

  test('Output is not larger than input', async () => {
    const result = await minifyString(HTML_CLEAN);
    assert.ok(Buffer.byteLength(result) <= Buffer.byteLength(HTML_CLEAN));
  });

  test('Collapses whitespace with default preset', async () => {
    const result = await minifyString('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><p>  Hello   world  </p></body></html>');
    assert.ok(!result.includes('  Hello'));
  });

  test('Respects options override', async () => {
    const loose = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><p>  Hello   world  </p></body></html>';
    const result = await minifyString(loose, { options: { collapseWhitespace: false } });
    assert.ok(result.includes('  Hello'));
  });
});

// Programmatic API: `read`

describe('Read files', () => {
  const fileClean = path.join(tempDir, 'clean.html');

  test('Returns a Map of path to content', async () => {
    const result = await read([fileClean]);
    assert.ok(result instanceof Map);
    assert.ok(result.has(fileClean));
    assert.ok(result.get(fileClean).includes('Yes'));
  });

  test('Skips unreadable files gracefully', async () => {
    const missing = path.join(tempDir, 'nonexistent.html');
    const result = await read([fileClean, missing]);
    assert.ok(result.has(fileClean));
    assert.ok(!result.has(missing));
    assert.strictEqual(result.size, 1);
  });
});

// Programmatic API: `collect`

describe('Collect files', () => {
  test('Collects .html and .htm files', async () => {
    const mixDir = path.join(tempDir, 'mix');
    fs.mkdirSync(mixDir, { recursive: true });
    fs.writeFileSync(path.join(mixDir, 'a.html'), '<p>A</p>');
    fs.writeFileSync(path.join(mixDir, 'b.htm'), '<p>B</p>');
    fs.writeFileSync(path.join(mixDir, 'c.txt'), 'not html');

    const files = await collect(mixDir);
    assert.strictEqual(files.length, 2);
    assert.ok(files.every(f => f.endsWith('.html') || f.endsWith('.htm')));

    fs.rmSync(mixDir, { recursive: true, force: true });
  });

  test('Skips node_modules and .git directories', async () => {
    const skipDir = path.join(tempDir, 'skip');
    fs.mkdirSync(path.join(skipDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(skipDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(skipDir, 'page.html'), '<p>Root</p>');
    fs.writeFileSync(path.join(skipDir, 'node_modules', 'dep.html'), '<p>Dep</p>');
    fs.writeFileSync(path.join(skipDir, '.git', 'hook.html'), '<p>Hook</p>');

    const files = await collect(skipDir);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith('page.html'));

    fs.rmSync(skipDir, { recursive: true, force: true });
  });

  test('Collects a single file when given a file path directly', async () => {
    const fileClean = path.join(tempDir, 'clean.html');
    const files = await collect(fileClean);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0], fileClean);
  });

  test('Returns empty array for a non-HTML file path', async () => {
    const txtFile = path.join(tempDir, 'readme.txt');
    fs.writeFileSync(txtFile, 'hello');
    const files = await collect(txtFile);
    assert.strictEqual(files.length, 0);
    fs.unlinkSync(txtFile);
  });

  test('Returns empty array for a non-existent path', async () => {
    const files = await collect(path.join(tempDir, 'ghost.html'));
    assert.strictEqual(files.length, 0);
  });

  test('Respects custom extensions', async () => {
    const extDir = path.join(tempDir, 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'page.html'), '<p>A</p>');
    fs.writeFileSync(path.join(extDir, 'page.xhtml'), '<p>B</p>');

    const files = await collect(extDir, new Set(['xhtml']));
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith('.xhtml'));

    fs.rmSync(extDir, { recursive: true, force: true });
  });

  test('Respects custom excluded directories', async () => {
    const exclDir = path.join(tempDir, 'excluded');
    fs.mkdirSync(path.join(exclDir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(exclDir, 'page.html'), '<p>Root</p>');
    fs.writeFileSync(path.join(exclDir, 'cache', 'dep.html'), '<p>Cached</p>');

    const files = await collect(exclDir, undefined, new Set(['cache']));
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith('page.html'));

    fs.rmSync(exclDir, { recursive: true, force: true });
  });

  test('Follows symlinked HTML files whose target is within the scanned root', async () => {
    const symlinkDir = path.join(tempDir, 'symlink_in_root');
    fs.mkdirSync(symlinkDir, { recursive: true });
    fs.writeFileSync(path.join(symlinkDir, 'real.html'), '<p>Real</p>');
    try {
      fs.symlinkSync(path.join(symlinkDir, 'real.html'), path.join(symlinkDir, 'link.html'));
    } catch {
      fs.rmSync(symlinkDir, { recursive: true, force: true });
      return; // Symlinks not supported on this platform/environment
    }
    const files = await collect(symlinkDir);
    assert.ok(files.some(f => f.endsWith('real.html')));
    assert.ok(files.some(f => f.endsWith('link.html')));
    fs.rmSync(symlinkDir, { recursive: true, force: true });
  });

  test('Does not follow symlinked HTML files whose target is outside the scanned root', async () => {
    const outerDir = path.join(tempDir, 'symlink_outer');
    const innerDir = path.join(tempDir, 'symlink_inner');
    fs.mkdirSync(outerDir, { recursive: true });
    fs.mkdirSync(innerDir, { recursive: true });
    fs.writeFileSync(path.join(outerDir, 'outside.html'), '<p>Outside</p>');
    try {
      fs.symlinkSync(path.join(outerDir, 'outside.html'), path.join(innerDir, 'link.html'));
    } catch {
      fs.rmSync(outerDir, { recursive: true, force: true });
      fs.rmSync(innerDir, { recursive: true, force: true });
      return;
    }
    const files = await collect(innerDir);
    assert.strictEqual(files.length, 0);
    fs.rmSync(outerDir, { recursive: true, force: true });
    fs.rmSync(innerDir, { recursive: true, force: true });
  });
});

// Programmatic API: `loadConfig`

describe('Load config', () => {
  test('Returns empty object when no config exists', async () => {
    const configDir = path.join(tempDir, 'noconfig');
    fs.mkdirSync(configDir, { recursive: true });
    const config = await loadConfig(configDir);
    assert.deepStrictEqual(config, {});
    fs.rmdirSync(configDir);
  });

  test('Loads hihtml.config.json', async () => {
    const configDir = path.join(tempDir, 'withconfig');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'hihtml.config.json'),
      JSON.stringify({ validation: { preset: 'standard' } })
    );
    const config = await loadConfig(configDir);
    assert.strictEqual(config.validation?.preset, 'standard');
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('Loads .hihtml.json (former name, still supported)', async () => {
    const configDir = path.join(tempDir, 'withlegacyconfig');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.hihtml.json'),
      JSON.stringify({ validation: { preset: 'standard' } })
    );
    const config = await loadConfig(configDir);
    assert.strictEqual(config.validation?.preset, 'standard');
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('hihtml.config.json takes precedence over .hihtml.json', async () => {
    const configDir = path.join(tempDir, 'bothfileconfig');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'hihtml.config.json'), JSON.stringify({ validation: { preset: 'a11y' } }));
    fs.writeFileSync(path.join(configDir, '.hihtml.json'), JSON.stringify({ validation: { preset: 'standard' } }));
    const config = await loadConfig(configDir);
    assert.strictEqual(config.validation?.preset, 'a11y');
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('Loads `hihtml` key from package.json', async () => {
    const configDir = path.join(tempDir, 'pkgconfig');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'package.json'),
      JSON.stringify({ name: 'test', hihtml: { minification: { preset: 'conservative' } } })
    );
    const config = await loadConfig(configDir);
    assert.strictEqual(config.minification?.preset, 'conservative');
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('Throws on malformed .hihtml.json', async () => {
    const configDir = path.join(tempDir, 'badconfig');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.hihtml.json'), 'not valid json {');
    await assert.rejects(() => loadConfig(configDir), /Error reading .hihtml.json/);
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('.hihtml.json takes precedence over package.json', async () => {
    const configDir = path.join(tempDir, 'bothconfig');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.hihtml.json'), JSON.stringify({ validation: { preset: 'a11y' } }));
    fs.writeFileSync(path.join(configDir, 'package.json'), JSON.stringify({ hihtml: { validation: { preset: 'standard' } } }));
    const config = await loadConfig(configDir);
    assert.strictEqual(config.validation?.preset, 'a11y');
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('Loads a standalone settings file when `filePath` is given', async () => {
    const filePath = path.join(tempDir, 'custom-settings.json');
    fs.writeFileSync(filePath, JSON.stringify({ validation: { preset: 'a11y' } }));
    const config = await loadConfig(undefined, filePath);
    assert.strictEqual(config.validation?.preset, 'a11y');
    fs.unlinkSync(filePath);
  });

  test('Reads `hihtml` key from settings file when present', async () => {
    const filePath = path.join(tempDir, 'pkg-style-settings.json');
    fs.writeFileSync(filePath, JSON.stringify({ name: 'my-project', hihtml: { validation: { preset: 'a11y' } } }));
    const config = await loadConfig(undefined, filePath);
    assert.strictEqual(config.validation?.preset, 'a11y');
    fs.unlinkSync(filePath);
  });

  test('Settings file takes precedence over CWD config', async () => {
    const configDir = path.join(tempDir, 'settings-vs-cwd');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.hihtml.json'), JSON.stringify({ validation: { preset: 'standard' } }));
    const filePath = path.join(tempDir, 'override-settings.json');
    fs.writeFileSync(filePath, JSON.stringify({ validation: { preset: 'a11y' } }));
    const config = await loadConfig(configDir, filePath);
    assert.strictEqual(config.validation?.preset, 'a11y');
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.unlinkSync(filePath);
  });

  test('Throws when settings file does not exist', async () => {
    const missing = path.join(tempDir, 'nonexistent-settings.json');
    await assert.rejects(() => loadConfig(undefined, missing), /Error reading settings file/);
  });

  test('Throws on invalid `links.timeout` type', async () => {
    const configDir = path.join(tempDir, 'badtype-timeout');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.hihtml.json'), JSON.stringify({ links: { timeout: 'ten seconds' } }));
    await assert.rejects(() => loadConfig(configDir), /links\.timeout.*must be a positive number/);
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('Throws on non-integer `links.concurrency`', async () => {
    const configDir = path.join(tempDir, 'badtype-concurrency');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.hihtml.json'), JSON.stringify({ links: { concurrency: 0 } }));
    await assert.rejects(() => loadConfig(configDir), /links\.concurrency.*must be a positive integer/);
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('Throws on invalid `extensions` type', async () => {
    const configDir = path.join(tempDir, 'badtype-extensions');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.hihtml.json'), JSON.stringify({ extensions: 'html' }));
    await assert.rejects(() => loadConfig(configDir), /extensions.*must be an array of strings/);
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('Throws on invalid `validation.preset` type', async () => {
    const configDir = path.join(tempDir, 'badtype-preset');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.hihtml.json'), JSON.stringify({ validation: { preset: 42 } }));
    await assert.rejects(() => loadConfig(configDir), /validation\.preset.*must be a string/);
    fs.rmSync(configDir, { recursive: true, force: true });
  });
});