import { styleText } from 'node:util';

const isTTY = process.stderr.isTTY;

/** @type {{ error: (t: string) => string, warning: (t: string) => string, success: (t: string) => string, bold: (t: string) => string }} */
const s = {
  error: (t) => isTTY ? styleText('red', t) : t,
  warning: (t) => isTTY ? styleText('yellow', t) : t,
  success: (t) => isTTY ? styleText('green', t) : t,
  bold: (t) => isTTY ? styleText('bold', t) : t,
};

export { s as style };

/**
 * @param {import('../adapters/validate.js').ResultCodeValidation} result
 * @param {boolean} [quiet]
 * @returns {string}
 */
export function formatValidationResult(result, quiet = false) {
  const withIssues = result.files.filter(f => f.messages.length > 0);
  const cleanCount = result.files.length - withIssues.length;

  if (quiet && result.countErrors === 0 && result.countWarnings === 0) {
    if (result.countIgnored > 0)
      return `${s.bold('Validation (HTML-validate)')}—${result.countIgnored} ${result.countIgnored === 1 ? 'issue' : 'issues'} ignored`;
    return '';
  }

  const lines = [s.bold('Validation (HTML-validate)')];

  for (const file of withIssues) {
    const errors = file.messages.filter(m => m.severity === 2 && !m.ignored).length;
    const warnings = file.messages.filter(m => m.severity === 1 && !m.ignored).length;
    const ignoredCount = file.messages.filter(m => m.ignored).length;
    const parts = [
      errors ? s.error(`${errors} ${errors === 1 ? 'error' : 'errors'}`) : '',
      warnings ? s.warning(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`) : '',
      ignoredCount ? `${ignoredCount} ${ignoredCount === 1 ? 'issue' : 'issues'} ignored` : '',
    ].filter(Boolean);
    lines.push(`  ${file.path}: ${parts.join(', ')}`);
    if (!quiet) {
      for (const msg of file.messages) {
        if (msg.ignored) {
          lines.push(`  – Line ${msg.line}, col ${msg.col}: ${msg.message} (${msg.ruleId})`);
        } else {
          const mark = msg.severity === 2 ? s.error('  ✕') : s.warning('  ⚠');
          lines.push(`${mark} Line ${msg.line}, col ${msg.col}: ${msg.message} (${msg.ruleId})`);
        }
      }
    }
  }

  if (!quiet && cleanCount > 0) {
    lines.push(`  ${s.success(`${cleanCount} ${cleanCount === 1 ? 'file' : 'files'}: no issues`)}`);
  }

  return lines.join('\n');
}

/**
 * @param {import('../adapters/check-code.js').ResultCodeDeprecation} result
 * @param {boolean} [quiet]
 * @returns {string}
 */
export function formatDeprecationResult(result, quiet = false) {
  const withIssues = result.files.filter(f => f.error || f.elements.length > 0 || f.attributes.length > 0);
  const cleanCount = result.files.length - withIssues.length;

  if (quiet && withIssues.length === 0) return '';

  const lines = [s.bold('Deprecated markup (ObsoHTML)')];

  for (const file of withIssues) {
    if (file.error) {
      lines.push(`  ${file.path}: ${s.error(`Error: ${file.error}`)}`);
    } else {
      const count = file.elements.length + file.attributes.length;
      lines.push(`  ${file.path}: ${s.warning(`${count} ${count === 1 ? 'issue' : 'issues'}`)}`);
      if (!quiet) {
        for (const el   of file.elements)   lines.push(`    ${s.warning('⚠')} Deprecated element: <${el}>`);
        for (const attr of file.attributes) lines.push(`    ${s.warning('⚠')} Deprecated attribute: ${attr}`);
      }
    }
  }

  if (!quiet && cleanCount > 0) {
    lines.push(`  ${s.success(`${cleanCount} ${cleanCount === 1 ? 'file' : 'files'}: no issues`)}`);
  }

  return lines.join('\n');
}

/**
 * @param {import('../adapters/check-links.js').ResultLinks} result
 * @param {boolean} [quiet]
 * @returns {string}
 */
export function formatLinkCheckResult(result, quiet = false) {
  const withIssues = result.files.filter(f =>
    f.error || f.links.some(l => !l.ok || l.skipped || l.warning === 'permanent-redirect')
  );
  const cleanCount = result.files.length - withIssues.length;

  const hasRealIssues = result.countBroken > 0 || result.countFileErrors > 0
    || result.files.some(f => f.links.some(l => l.warning === 'permanent-redirect'));
  if (quiet && !hasRealIssues) return '';

  const lines = [s.bold('Links (built-in http/https)')];

  for (const file of withIssues) {
    if (file.error) {
      lines.push(`  ${file.path}: ${s.error(`Error: ${file.error}`)}`);
      continue;
    }

    const broken = file.links.filter(l => !l.ok);
    const warned = file.links.filter(l => l.ok && !l.skipped && l.warning === 'permanent-redirect');
    const skipped = file.links.filter(l => l.skipped);
    const checked = file.links.filter(l => !l.skipped);

    const parts = [];
    if (broken.length > 0) parts.push(s.warning(`${broken.length} broken`));
    if (warned.length > 0) parts.push(s.warning(`${warned.length} permanent ${warned.length === 1 ? 'redirect' : 'redirects'}`));
    if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
    const checkedStr = checked.length > 0
      ? `${checked.length} ${checked.length === 1 ? 'link' : 'links'} checked, `
      : '';
    lines.push(`  ${file.path}: ${checkedStr}${parts.join(', ')}`);

    if (!quiet) {
      for (const link of broken) {
        const detail = link.error ?? String(link.status);
        lines.push(`  ${s.warning('  ✕')} ${link.url} – ${detail}`);
      }
      for (const link of warned) {
        lines.push(`  ${s.warning('  ⚠')} ${link.url} – ${link.redirectStatus} (permanent redirect)`);
      }
      for (const link of skipped) {
        lines.push(`    – ${link.url} – (skipped)`);
      }
    }
  }

  if (!quiet && cleanCount > 0 && (withIssues.length > 0 || result.countChecked > 0 || result.countSkipped > 0)) {
    lines.push(`  ${s.success(`${cleanCount} ${cleanCount === 1 ? 'file' : 'files'}: no issues`)}`);
  }

  const total = result.countChecked;
  const summaryCount = total === 0 && result.countSkipped === 0
    ? 'no http/https links'
    : total === 0
      ? `no URLs checked`
      : `${total} unique ${total === 1 ? 'URL' : 'URLs'} checked`;
  const summarySkipped = result.countSkipped > 0
    ? `, ${result.countSkipped} skipped`
    : '';
  const summaryFileErrors = result.countFileErrors > 0
    ? `, ${s.error(`${result.countFileErrors} file ${result.countFileErrors === 1 ? 'error' : 'errors'}`)}`
    : '';
  const summaryBroken = result.countBroken === 0 && result.countFileErrors === 0
    ? s.success('no broken links')
    : s.warning(`${result.countBroken} broken`);

  lines.push(`\n  ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'} · ${summaryCount}${summarySkipped}${summaryFileErrors} · ${summaryBroken}`);

  return lines.join('\n');
}

/**
 * @param {import('../adapters/minify.js').ResultMinification} result
 * @param {boolean} [quiet]
 * @returns {string}
 */
export function formatMinificationResult(result, quiet = false) {
  const hasErrors = result.files.some(f => f.error);
  if (quiet && !hasErrors) return '';

  const lines = [s.bold('Minification (HTML Minifier Next)')];
  let saved = 0;

  for (const file of result.files) {
    if (file.error) {
      lines.push(`  ${file.path}: ${s.error(`Error: ${file.error}`)}`);
    } else {
      saved += Math.max(0, file.sizeOriginal - file.sizeMinified);
    }
  }

  if (!quiet) {
    const successCount = result.files.filter(f => !f.error).length;
    lines.push(`\n  ${s.success(`${successCount} ${successCount === 1 ? 'file' : 'files'} minified, ${formatBytes(saved)} saved`)}`);
  }

  return lines.join('\n');
}

/** @param {number} bytes @returns {string} */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
