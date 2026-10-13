import type {
  ResultCodeValidation,
  ResultCodeDeprecation,
  ResultCodeDeprecationOccurrence,
  ResultCode,
  ResultLinksUrl,
  ResultLinksFragment,
  ResultLinksFile,
  ResultLinks,
  ResultMinification,
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
  ResultCodeValidation,
  ResultCodeDeprecation,
  ResultCodeDeprecationOccurrence,
  ResultCode,
  ResultLinksUrl,
  ResultLinksFragment,
  ResultLinksFile,
  ResultLinks,
  ResultMinification,
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