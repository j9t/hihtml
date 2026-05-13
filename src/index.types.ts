import type {
  ValidationResult,
  DeprecationResult,
  CheckResult,
  LinkResult,
  FileLinkResult,
  LinkCheckResult,
  MinificationResult,
  HihtmlConfig,
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
  HihtmlConfig,
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