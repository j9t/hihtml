export declare const HTML_EXTENSIONS: Set<string>;
export declare const EXCLUDED_DIRS: Set<string>;

export interface MessageValidation {
  ruleId: string;
  severity: 1 | 2;
  message: string;
  line: number;
  col: number;
  ignored?: boolean;
}

export interface ResultCodeValidationFile {
  path: string;
  messages: MessageValidation[];
}

export interface ResultCodeValidation {
  files: ResultCodeValidationFile[];
  countErrors: number;
  countWarnings: number;
  countIgnored: number;
}

export interface ResultCodeDeprecationFile {
  path: string;
  elements: string[];
  attributes: string[];
  error?: string;
}

export interface ResultCodeDeprecation {
  files: ResultCodeDeprecationFile[];
  countIssues: number;
}

export interface ResultCode {
  validation: ResultCodeValidation;
  deprecation: ResultCodeDeprecation;
}

export interface ResultLinksUrl {
  url: string;
  status: number | null;
  ok: boolean;
  skipped?: boolean;
  warning?: string;
  redirectStatus?: number;
  error?: string;
}

export interface ResultLinksFile {
  path: string;
  links: ResultLinksUrl[];
  countBroken: number;
  error?: string;
}

export interface ResultLinks {
  files: ResultLinksFile[];
  countBroken: number;
  countChecked: number;
  countSkipped: number;
  countFileErrors: number;
}

export interface ResultMinificationFile {
  path: string;
  sizeOriginal: number;
  sizeMinified: number;
  error?: string;
}

export interface ResultMinification {
  files: ResultMinificationFile[];
  saved: number;
}

export interface HihtmlConfig {
  extensions?: string[];
  ignore?: string[];
  validation?: { preset?: string; ignore?: string[] };
  minification?: { preset?: string; options?: Record<string, unknown> };
  links?: {
    timeout?: number;
    concurrency?: number;
    warnOnPermanentRedirects?: boolean;
    ignore?: string[];
  };
}

export declare function collect(
  dir: string,
  extensions?: Set<string>,
  excludedDirs?: Set<string>
): Promise<string[]>;

export declare function read(
  filePaths: string[],
  options?: { concurrency?: number; onProgress?: () => void }
): Promise<Map<string, string>>;

export declare function loadConfig(cwd?: string, filePath?: string): Promise<HihtmlConfig>;

export declare function checkCode(
  filePaths: string[],
  options?: { preset?: string; ignore?: string[]; concurrency?: number; contents?: Map<string, string>; onProgress?: () => void }
): Promise<ResultCode>;

export declare function checkCodeString(
  content: string,
  options?: { preset?: string; ignore?: string[] }
): Promise<ResultCode>;

export declare function checkLinks(
  filePaths: string[],
  options?: {
    concurrency?: number;
    timeout?: number;
    warnOnPermanentRedirects?: boolean;
    ignore?: string[];
    contents?: Map<string, string>;
    onProgress?: () => void;
    onStart?: (total: number) => void;
  }
): Promise<ResultLinks>;

export declare function checkLinksString(
  content: string,
  options?: {
    concurrency?: number;
    timeout?: number;
    warnOnPermanentRedirects?: boolean;
    ignore?: string[];
    onProgress?: () => void;
    onStart?: (total: number) => void;
  }
): Promise<ResultLinks>;

export declare function minify(
  filePaths: string[],
  outputPaths: string[],
  options?: { preset?: string; options?: Record<string, unknown>; concurrency?: number; contents?: Map<string, string>; onProgress?: () => void }
): Promise<ResultMinification>;

export declare function minifyString(
  content: string,
  options?: { preset?: string; options?: Record<string, unknown> }
): Promise<string>;