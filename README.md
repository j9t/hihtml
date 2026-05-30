# hihtml, the HTML Processing Supertool

[![npm version](https://img.shields.io/npm/v/hihtml.svg)](https://www.npmjs.com/package/hihtml) [![Build status](https://github.com/j9t/hihtml/workflows/Tests/badge.svg)](https://github.com/j9t/hihtml/actions) [![Socket](https://badge.socket.dev/npm/package/hihtml)](https://socket.dev/npm/package/hihtml) [![GitHub Sponsors](https://badgen.net/static/Support/Open%20Source/cyan)](https://github.com/j9t/hihtml?sponsor=1)

hihtml—“high-quality HTML”—bundles several key HTML tools into one, making HTML validation and semantics control, link checking, and minification as easy as it gets: [HTML-validate](https://html-validate.org/) for validation, [ObsoHTML](https://github.com/j9t/obsohtml) for deprecated markup detection, Node’s built-in `http`/`https` for link checking, and [HTML Minifier Next](https://github.com/j9t/html-minifier-next) for minification. hihtml provides a CLI and a programmatic API, and comes with strong defaults but is still highly configurable.

## Usage

### 1. CLI

#### Installation

Consider using hihtml via npx:

```shell
npx hihtml
```

#### Execution

Without options, hihtml validates HTML files and checks for deprecated markup in the current directory. Use flags to control behavior:

| Flag | Description |
|---|---|
| `-c`, `--check-code` | Check HTML code: validate and check for deprecated markup (default) |
| `-l`, `--check-links` | Check all external http/https URLs for broken references |
| `-m`, `--minify` | Minify HTML files in-place, or to `--output` |
| `-a`, `--all` | Check HTML code and links, then minify if there are no validation errors (built-in conformance gate—different from using all individual flags together) |
| `-i`, `--input <dir>` | Input directory (default: current directory) |
| `-o`, `--output <dir>` | Output directory for minification |
| `-s`, `--settings <file>` | Load configuration from a specific JSON file (overrides CWD config lookup) |
| `-q`, `--quiet` | Suppress output when no issues are found |
| `-r`, `--report [file]` | Save a JSON report (default: `hihtml-report.json`) |
| `-v`, `--version` | Show version number |
| `-h`, `--help` | Show help |

##### Example Commands

Check the current directory:

```shell
npx hihtml
```

Check a specific folder:

```shell
npx hihtml -c -i path/to/project
```

Check all external http/https URLs in the current directory:

```shell
npx hihtml -l
```

Check markup and links together:

```shell
npx hihtml -c -l
```

Minify HTML files in-place (prompts for confirmation):

```shell
npx hihtml -m
```

Minify into a separate output directory:

```shell
npx hihtml -m -i src -o dist
```

Check, then minify only if validation passes:

```shell
npx hihtml -a
```

Use a specific settings file:

```shell
npx hihtml -s ~/my-hihtml.json
npx hihtml -a -i /path/to/site -s ~/my-hihtml.json
```

Save a JSON report:

```shell
npx hihtml -r
npx hihtml -r results.json
```

Run quietly (no output when clean, useful in CI):

```shell
npx hihtml -q
npx hihtml -q -l
npx hihtml -q -a -i src -o dist
```

### 2. Programmatic API

Install hihtml in your project, e.g., via `npm i -D hihtml`, then import and use what you need:

```js
import { checkCode, checkCodeString, checkLinks, checkLinksString, minify, minifyString, collect } from 'hihtml';

const files = await collect('./src');

const checks = await checkCode(files);
// { validation: { files, countErrors, countWarnings, countIgnored }, deprecation: { files, countIssues } }

const links = await checkLinks(files);
// { files: [{ path, links: [{ url, status, ok, skipped?, warning?, error? }], countBroken }], countBroken, countChecked, countSkipped, countFileErrors }

const minification = await minify(files, files); // in-place
// { files: [{ path, sizeOriginal, sizeMinified }], saved }

// String variants—same result types, no file I/O
const minified = await minifyString('<p>Hello  world</p>');
const codeGate = await checkCodeString('<p><div>Nope</div></p>');
const linksCleaned = await checkLinksString('<a href=https://example.com/>Example</a>');
```

#### `collect(dir, extensions?, excludedDirs?)`

Recursively collects HTML files from `dir`. Returns `Promise<string[]>`.

* `extensions`: `Set<string>` of file extensions without dots (default: `html`, `htm`, `shtml`, `shtm`)
* `excludedDirs`: `Set<string>` of directory names to skip (default: `node_modules`, `.git`)

Symlinked files whose target resolves within the scanned root are followed; symlinks pointing outside the root or to directories are skipped.

#### `checkCode(filePaths, options?)`

Validates HTML files and checks for deprecated markup. Returns `Promise<ResultCode>` with `validation` (HTML-validate result) and `deprecation` (ObsoHTML result) properties.

* `options.preset`: HTML-validate preset name (default: `'standard'`)
* `options.ignore`: List of [HTML-validate rule IDs](https://html-validate.org/rules/index.html) to suppress (default: `[]`)

#### `checkCodeString(content, options?)`

Validates an HTML string and checks for deprecated markup. Returns `Promise<ResultCode>`—same shape as `checkCode`. Useful in content-pipeline contexts (Eleventy transforms, middleware, SSR) where HTML is available as a string rather than a file.

* `options.preset`: HTML-validate preset name (default: `'standard'`)
* `options.ignore`: List of HTML-validate rule IDs to suppress (default: `[]`)

Note: `result.validation.files[0].path` and `result.deprecation.files[0].path` will be `'(string input)'`, not a real file path.

#### `checkLinks(filePaths, options?)`

Checks all external http/https URLs (`href`, `src`, `srcset`, `action` attributes) found in the given HTML files. Each unique URL is checked once; results are mapped back to every file it appears in. Returns `Promise<ResultLinks>`.

* `options.timeout`: Request timeout in milliseconds (default: `10000`)
* `options.concurrency`: Maximum concurrent requests (default: `8`)
* `options.warnOnPermanentRedirects`: Warn on 301/308 permanent redirects (default: `false`)
* `options.ignore`: List of hostnames or URL prefixes to skip (default: `[]`)
* `options.onStart`: Called once with the total number of URLs to check
* `options.onProgress`: Called after each URL is checked

Links are checked via HEAD request, falling back to GET on 405. 4xx and 5xx responses are reported as broken. Skipped URLs (from the ignore list) appear in results with `skipped: true` and are never counted as broken.

#### `checkLinksString(content, options?)`

Checks all external http/https URLs found in an HTML string. Returns `Promise<ResultLinks>`—same shape as `checkLinks`. Useful when HTML is available as a string rather than a file, e.g., to check links in a fetched document or API response.

* `options.timeout`: Request timeout in milliseconds (default: `10000`)
* `options.concurrency`: Maximum concurrent requests (default: `8`)
* `options.warnOnPermanentRedirects`: Warn on 301/308 permanent redirects (default: `false`)
* `options.ignore`: List of hostnames or URL prefixes to skip (default: `[]`)
* `options.onStart`: Called once with the total number of URLs to check
* `options.onProgress`: Called after each URL is checked

Note: `result.files[0].path` will be `'(string input)'`, not a real file path. `result.countFileErrors` will always be `0`.

#### `minify(filePaths, outputPaths, options?)`

Minifies HTML files using HTML Minifier Next. Returns `Promise<ResultMinification>`.

* `outputPaths`: Parallel array of output paths; pass the same value as `filePaths` for in-place minification
* `options.preset`: HTML Minifier Next preset name (default: `'comprehensive'`)
* `options.options`: Additional HTML Minifier Next options to merge with the preset

#### `minifyString(content, options?)`

Minifies an HTML string using HTML Minifier Next. Returns `Promise<string>`. Useful in content-pipeline contexts (Eleventy transforms, middleware, SSR) where HTML is available as a string rather than a file.

* `options.preset`: HTML Minifier Next preset name (default: `'comprehensive'`)
* `options.options`: Additional HTML Minifier Next options to merge with the preset

#### `loadConfig(cwd?, filePath?)`

Loads hihtml configuration. When `filePath` is given, only that file is read (no CWD fallback); if it contains a `"hihtml"` key that value is used, otherwise the root object is used. Without `filePath`, reads `.hihtml.json` or the `"hihtml"` key in `package.json` from `cwd`. Returns `Promise<HihtmlConfig>`.

## Configuration

Create a .hihtml.json file in your project root, or add a `"hihtml"` key to package.json. Both use the same format (here showing hihtml’s defaults):

```json
{
  "extensions": ["html", "htm", "shtml", "shtm"],
  "ignore": ["node_modules", ".git"],
  "validation": {
    "preset": "standard",
    "ignore": []
  },
  "links": {
    "timeout": 10000,
    "concurrency": 8,
    "warnOnPermanentRedirects": false,
    "ignore": []
  },
  "minification": {
    "preset": "comprehensive"
  }
}
```

.hihtml.json takes precedence over package.json when both are present.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | No issues found (ObsoHTML warnings on deprecated markup are informational) |
| `1` | Validation errors, broken links, or minification errors found |
| `2` | Tool or runtime error |

## FAQ

### How do I only run select checks?

Use the individual flags (`-c`, `-l`, `-m`) instead of `--all`/`-a`. Each flag only exits “1” for issues within its own scope, so you control exactly what affects the exit code. To suppress specific HTML-validate rule IDs without disabling validation entirely, use `validation.ignore` in your configuration. To suppress specific broken links without skipping link checking altogether, use `links.ignore`.

### Where do I report issues?

If in doubt or in a hurry, [report issues here](https://github.com/j9t/hihtml/issues/new). Otherwise, if the issue is related to HTML-validate, [report it with HTML-validate](https://gitlab.com/html-validate/html-validate/-/work_items/new?type=Issue&initialCreationContext=list-route). If the issue is related to ObsoHTML, [report it with ObsoHTML](https://github.com/j9t/obsohtml/issues/new). For HTML Minifier Next issues, [report them with HMN](https://github.com/j9t/html-minifier-next/issues/new). All projects are maintained and monitored and should respond promptly. Thank you!

### What does ObsoHTML do here when HTML-validate already reports on deprecated markup?

At the moment, ObsoHTML catches some elements and attributes that HTML-validate doesn’t. Once HTML-validate covers everything ObsoHTML covers, ObsoHTML is going to be removed from hihtml. Note that ObsoHTML is purely informational—it doesn’t prevent minification when used with the `--all`/`-a` flag.

***

You might like some of my other work:

* Optimization tools: hihtml · [HTML Minifier Next](https://github.com/j9t/html-minifier-next) · [ObsoHTML](https://github.com/j9t/obsohtml) · [Image Guard](https://github.com/j9t/image-guard) · [Compressor.js Next](https://github.com/j9t/compressorjs-next) · [.htaccess Punk](https://github.com/j9t/htaccess-punk)
* Defense tools: [IA Defensa](https://iadefensa.com/solutions/)
* Resources for quality web development: [Articles](https://meiert.com/topics/development/) · [Books](https://meiert.com/topics/books/) (including [_On Web Development_](https://meiert.com/blog/on-web-development-2/)) · [News](https://frontenddogma.com/) · [Terminology](https://webglossary.info/)