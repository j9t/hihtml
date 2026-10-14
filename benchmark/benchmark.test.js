import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CORPUS_HOSTS, generate } from './corpus.js';
import {
  DEFAULT_ITERATIONS,
  TASKS,
  baselineEntry,
  fastest,
  formatTimeDelta,
  main,
  median,
  parseArgs,
  reproducibility,
  spread,
  summarize,
} from './benchmark.js';

describe('Benchmark', () => {
  describe('`parseArgs`', () => {
    test('Defaults to all tasks and the default iteration count', () => {
      assert.deepStrictEqual(parseArgs([]), {
        save: false,
        iterations: DEFAULT_ITERATIONS,
        tasks: Object.keys(TASKS),
      });
    });

    test('Reads flags and values', () => {
      assert.deepStrictEqual(parseArgs(['--save', '--iterations=10']), {
        save: true,
        iterations: 10,
        tasks: Object.keys(TASKS),
      });
    });

    test('`--iterations` falls back to the default when not a number, and to 1 when lower', () => {
      assert.strictEqual(parseArgs(['--iterations=many']).iterations, DEFAULT_ITERATIONS);
      assert.strictEqual(parseArgs(['--iterations=0']).iterations, 1);
    });

    test('`--task` selects tasks and deduplicates them', () => {
      assert.deepStrictEqual(parseArgs(['--task=check-links', '--task=minify', '--task=check-links']).tasks, ['check-links', 'minify']);
    });

    test('`parseArgs` rejects an unknown task, naming the available ones', () => {
      assert.throws(() => parseArgs(['--task=nope']), { message: /Unknown task “nope”; available tasks: / });
    });
  });

  describe('Timing helpers', () => {
    test('`fastest` returns the minimum', () => {
      assert.strictEqual(fastest([3, 1, 2]), 1);
    });

    test('`median` averages the two middle values on an even count', () => {
      assert.strictEqual(median([1, 2, 3, 4]), 2.5);
      assert.strictEqual(median([1, 2, 3]), 2);
    });

    test('`reproducibility` compares the minima of both iteration halves', () => {
      assert.strictEqual(reproducibility([10, 10, 10, 10]), 0);
      assert.strictEqual(reproducibility([10, 10, 11, 11]), 10);
      assert.strictEqual(reproducibility([10, 10, 20, 20]), 100);
      assert.strictEqual(reproducibility([10]), null);
    });

    test('`spread` measures fastest-to-slowest', () => {
      assert.strictEqual(spread([10, 20]), 100);
      assert.strictEqual(spread([10, 10]), 0);
    });
  });

  describe('`baselineEntry`', () => {
    test('Rejects entries without a positive finite `time`', () => {
      for (const entry of [undefined, {}, { time: 0 }, { time: -1 }, { time: 'fast' }, { time: Infinity }]) {
        assert.strictEqual(baselineEntry(entry), undefined);
      }
    });

    test('Keeps a non-negative finite `spread` and drops any other', () => {
      assert.deepStrictEqual(baselineEntry({ time: 1, spread: 5, detail: 'd' }), { time: 1, spread: 5, detail: 'd' });
      assert.strictEqual(baselineEntry({ time: 1, spread: 0 }).spread, 0);
      for (const spread of [-1, 'x', null, undefined, NaN]) {
        assert.strictEqual(baselineEntry({ time: 1, spread }).spread, null);
      }
    });
  });

  describe('Delta formatting', () => {
    test('`formatTimeDelta` reads small deltas as within noise', () => {
      assert.strictEqual(formatTimeDelta(105, 100, 10), ' (~+5.0%, within noise)');
      assert.strictEqual(formatTimeDelta(115, 100, 10), ' (+15.0%)');
      assert.strictEqual(formatTimeDelta(100, 100, 10), ' (~+0.0%, within noise)');
    });
  });

  describe('Corpus', () => {
    test('`generate` is deterministic', () => {
      const a = generate();
      const b = generate();
      assert.deepStrictEqual(a, b);
    });

    test('Every absolute URL points at a corpus host, keeping runs offline', () => {
      for (const file of generate()) {
        for (const match of file.content.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
          const host = match[1];
          assert.ok(
            CORPUS_HOSTS.some(ignored => host === ignored || host.endsWith(`.${ignored}`)),
            `${file.name}: ${host} is not covered by CORPUS_HOSTS`
          );
        }
      }
    });

    test('Documents cover the range from small to large', () => {
      const sizes = generate().map(file => file.content.length);
      assert.ok(Math.min(...sizes) > 1_000, 'smallest document should be at least 1 KB');
      assert.ok(Math.max(...sizes) > 100_000, 'largest document should exceed 100 KB');
    });
  });

  describe('`summarize`', () => {
    test('Characterizes each task’s output', () => {
      assert.strictEqual(summarize('check-links', { countChecked: 2, countSkipped: 1, countFragmentsChecked: 4 }), '3 URLs, 4 fragment links');
      assert.strictEqual(
        summarize('check-code', { validation: { countErrors: 1, countWarnings: 2 }, deprecation: { countIssues: 3 } }),
        '6 issues'
      );
      assert.strictEqual(summarize('minify', 'ä'), '2 B minified');
    });
  });

  describe('`main`', () => {
    test('Runs all tasks against the generated corpus and reports per-file times', async () => {
      const dirWork = await fs.mkdtemp(path.join(os.tmpdir(), 'hihtml-benchmark-'));
      try {
        const { files } = await main({ argv: ['--iterations=2'], dirWork });
        for (const taskName of Object.keys(TASKS)) {
          for (const name of ['small', 'article', 'links', 'markup']) {
            const entry = files[taskName]?.[name];
            assert.ok(entry, `${taskName}/${name} missing from results`);
            assert.strictEqual(typeof entry.time, 'number');
            assert.ok(entry.time > 0, `${taskName}/${name} has no measured time`);
            assert.ok(typeof entry.detail === 'string' && entry.detail.length > 0);
          }
        }
      } finally {
        await fs.rm(dirWork, { recursive: true, force: true });
      }
    });

    test('`--save` writes a baseline that a later run compares against', async () => {
      const dirWork = await fs.mkdtemp(path.join(os.tmpdir(), 'hihtml-benchmark-'));
      try {
        await main({ argv: ['--iterations=2', '--save'], dirWork });
        const baseline = JSON.parse(await fs.readFile(path.join(dirWork, 'baseline.json'), 'utf8'));
        assert.strictEqual(baseline.metric, 'fastest');
        assert.ok(baseline.files['check-links'].small.time > 0);
        assert.ok(typeof baseline.files.minify.small.detail === 'string');

        // A second run loads the baseline and keeps identical details
        const { files } = await main({ argv: ['--iterations=2'], dirWork });
        assert.strictEqual(files.minify.small.detail, baseline.files.minify.small.detail);
      } finally {
        await fs.rm(dirWork, { recursive: true, force: true });
      }
    });

    test('Ignores baseline entries without a positive finite `time`', async () => {
      const dirWork = await fs.mkdtemp(path.join(os.tmpdir(), 'hihtml-benchmark-'));
      const log = console.log;
      const lines = [];
      try {
        const entries = { small: { time: 0 }, article: { time: 'fast', spread: 'x' }, links: { spread: 5 }, markup: { time: 1, spread: 'x' } };
        await fs.writeFile(path.join(dirWork, 'baseline.json'), JSON.stringify({ metric: 'fastest', files: { 'check-links': entries } }));
        console.log = (...args) => lines.push(args.join(' '));
        await main({ argv: ['--iterations=2', '--task=check-links'], dirWork });
      } finally {
        console.log = log;
        await fs.rm(dirWork, { recursive: true, force: true });
      }
      const output = lines.join('\n');
      assert.doesNotMatch(output, /NaN|Infinity|x%/);
      assert.match(output, /only 1 of 4 file\(s\) have a baseline entry/);
    });
  });
});