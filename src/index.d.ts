export declare const HTML_EXTENSIONS: Set<string>;
export declare const EXCLUDED_DIRS: Set<string>;

export interface ValidationMessage {
  ruleId: string;
  severity: 1 | 2;
  message: string;
  line: number;
  col: number;
  ignored?: boolean;
}

export interface FileValidationResult {
  path: string;
  messages: ValidationMessage[];
}

export interface ValidationResult {
  files: FileValidationResult[];
  countErrors: number;
  countWarnings: number;
  countIgnored: number;
}

export interface FileDeprecationResult {
  path: string;
  elements: string[];
  attributes: string[];
  error?: string;
}

export interface DeprecationResult {
  files: FileDeprecationResult[];
  countIssues: number;
}

export interface CheckResult {
  validation: ValidationResult;
  deprecation: DeprecationResult;
}

export interface LinkResult {
  url: string;
  status: number | null;
  ok: boolean;
  skipped?: boolean;
  warning?: string;
  redirectStatus?: number;
  error?: string;
}

export interface FileLinkResult {
  path: string;
  links: LinkResult[];
  countBroken: number;
  error?: string;
}

export interface LinkCheckResult {
  files: FileLinkResult[];
  countBroken: number;
  countChecked: number;
  countSkipped: number;
  countFileErrors: number;
}

export interface FileMinificationResult {
  path: string;
  sizeOriginal: number;
  sizeMinified: number;
  error?: string;
}

export interface MinificationResult {
  files: FileMinificationResult[];
  saved: number;
}

export interface HiHTMLConfig {
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

export declare function loadConfig(cwd?: string, filePath?: string): Promise<HiHTMLConfig>;

export declare function checkCode(
  filePaths: string[],
  options?: { preset?: string; ignore?: string[]; concurrency?: number; contents?: Map<string, string>; onProgress?: () => void }
): Promise<CheckResult>;

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
): Promise<LinkCheckResult>;

export declare function minify(
  filePaths: string[],
  outputPaths: string[],
  options?: { preset?: string; options?: Record<string, unknown>; concurrency?: number; contents?: Map<string, string>; onProgress?: () => void }
): Promise<MinificationResult>;
