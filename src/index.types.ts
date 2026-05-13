import type {
  ValidationResult,
  DeprecationResult,
  CheckResult,
  LinkResult,
  FileLinkResult,
  LinkCheckResult,
  MinificationResult,
  HiHTMLConfig,
} from './index.js';

import {
  checkCode,
  checkCodeString,
  checkLinks,
  checkLinksString,
  minify,
  minifyString,
  collect,
  read,
  loadConfig,
  HTML_EXTENSIONS,
  EXCLUDED_DIRS,
} from './index.js';

export type {
  ValidationResult,
  DeprecationResult,
  CheckResult,
  LinkResult,
  FileLinkResult,
  LinkCheckResult,
  MinificationResult,
  HiHTMLConfig,
};

export {
  checkCode,
  checkCodeString,
  checkLinks,
  checkLinksString,
  minify,
  minifyString,
  collect,
  read,
  loadConfig,
  HTML_EXTENSIONS,
  EXCLUDED_DIRS,
};