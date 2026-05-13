# Changelog

All notable changes to hihtml are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0-beta] - 2026-05-13

### Added

* Added string-based functions to programmatic API:
  - `checkCodeString(content, options?)` validates an HTML string and checks it for deprecated markup, mirroring `checkCode` for string-based pipelines
  - `checkLinksString(content, options?)` checks all external http/https URLs found in an HTML string, mirroring `checkLinks` for string-based pipelines
  - `minifyString(content, options?)` minifies an HTML string and returns it, without any file I/O—useful in content-pipeline contexts such as Eleventy transforms, middleware, and SSR handlers
* Extended URL extraction in link checking to also detect URLs in unquoted attributes (e.g., `href=https://example.com`, which is valid HTML)

### Changed

* Improved performance across several areas:
  - Directory traversal now fans out subdirectories in parallel (`Promise.all`)
  - `HtmlValidate` instances are cached per preset, avoiding re-initialization across calls to `validate()`/`checkCode()`
  - URL-extraction regexes in the link checker are compiled once at module load instead of per-call; extraction now uses `matchAll`
  - HTML Minifier Next import and preset resolution are cached per preset, avoiding repeated work across calls to `minifyString()`
  - Ignore-list entries are pre-classified into hostnames (Set) and prefix entries once per `checkLinks()` call, enabling O(1) exact-hostname lookup in the hot path

## [1.2.0-beta] - 2026-05-11

### Added

* Added `validation.ignore`, a list of HTML-validate rule IDs to suppress, mirroring `links.ignore`
  - Ignored messages appear in validation output (marked as ignored) but are not counted as errors and do not block minification when using `--all`/`-a`
  - Supported in configuration (`.hihtml.json`/`package.json`) and programmatically via `checkCode(files, { ignore: […] })`
  - `ValidationResult` now includes `countIgnored`; `ValidationMessage` now includes `ignored?: boolean`
* Added `-s`/`--settings <file>` flag to load configuration from a specific JSON file, overriding the default CWD config lookup
  - Accepts any JSON file, reading the `"hihtml"` key if present (same convention as `package.json`), otherwise using the root object
  - `loadConfig()` now accepts an optional `filePath` parameter for the same behavior programmatically
* Added `-q`/`--quiet` flag to suppress all output when no issues are found, for cleaner CI and script usage
* Enhanced progress indicators to show a color-coded dot: blue while processing, green on completion when no issues are found, yellow when issues are found

## [1.1.2-beta] - 2026-05-11

### Fixed

* Fixed link extraction incorrectly truncating URLs that contain an apostrophe inside a double-quoted `href` attribute (e.g., `href="https://example.com/you_aren't_gonna_need_it"`)

## [1.1.1-beta] - 2026-05-07

### Changed

* Renamed `-c`/`--check` to `-c`/`--check-code` for clarity, paralleling `-l`/`--check-links`; updated `--all` description accordingly
* Renamed programmatic API: `check` → `checkCode`; updated adapter filenames (`check.js` → `check-code.js`, `checklinks.js` → `check-links.js`) for consistency
* Updated default-mode preamble to “Checking for HTML code issues”
* Updated report `command` field (`check` → `check-code`) and results key (`check` → `checkCode`)

## [1.1.0-beta] - 2026-05-05

### Added

* Added `-l`/`--check-links` flag to check all http/https links for broken URLs (4xx/5xx responses); exits 1 when broken links are found
  - Link checking is also included automatically in `--all`/`-a` (after validation, before minification)
  - Programmatic `checkLinks()` API: extracts unique http/https URLs from HTML files, checks each once via HEAD (with GET fallback on 405), follows redirects, and maps results back per file; supports `timeout`, `concurrency`, `warnOnPermanentRedirects`, and `ignore` options
  - `links` configuration section in .hihtml.json/package.json for `timeout`, `concurrency`, `warnOnPermanentRedirects`, and `ignore`
  - `links.ignore`: list of hostnames or URL prefixes to skip; ignored URLs appear as skipped in output and do not affect the exit code

### Changed

* Allowed mode flags to be freely combined; `--all`/`-a` takes precedence when used alongside other mode flags
* Adjusted output to only list files with issues per section; clean files are collapsed into a single “N files: no issues” summary line
* Ensured running without flags prints a short preamble noting what is being checked, pointing to `-a` and `-h`

## [1.0.2-beta] - 2026-04-23

### Changed

* Cut directory exclusion defaults to node_modules and .git folders

## [1.0.1-beta] - 2026-04-21

### Changed

* Renamed and simplified programmatic API: `collectFiles` → `collect`, `readFiles` → `read`, `minifyFiles` → `minify`; merged `validateFiles` and `checkFiles` into a single `check` that mirrors `--check` CLI behavior and returns `{ validation, deprecation }`

## [1.0.0-beta] - 2026-04-21

### Added

* Released initial version