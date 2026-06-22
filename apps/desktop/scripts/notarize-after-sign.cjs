const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ATTEMPTS = Number(process.env.REBASE_NOTARIZE_ATTEMPTS || 5);

function shouldSkipNotarization({ platform, enabled, appPath }) {
  return platform !== 'darwin' || enabled !== '1' || !appPath;
}

function isTransientNotarytoolOutput(output) {
  return /Error:\s+HTTP/i.test(output) && /\b(408|429|500|502|503|504)\b/.test(output);
}

function notarytoolArgs(zipPath, key, keyId, issuer) {
  return [
    'notarytool',
    'submit',
    zipPath,
    '--key',
    key,
    '--key-id',
    keyId,
    '--issuer',
    issuer,
    '--wait',
    '--output-format',
    'json',
  ];
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for macOS notarization`);
  return value;
}

function submitWithRetry(zipPath) {
  const args = notarytoolArgs(zipPath, requireEnv('APPLE_API_KEY'), requireEnv('APPLE_API_KEY_ID'), requireEnv('APPLE_API_ISSUER'));
  let lastOutput = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const output = run('xcrun', args);
      let parsed;
      try {
        parsed = JSON.parse(output.trim());
      } catch (error) {
        throw new Error(`${output}\n${error.message}`);
      }
      if (parsed.status === 'Accepted') return parsed;
      throw new Error(`Notarization was not accepted: ${output}`);
    } catch (error) {
      const output = `${error.stdout || ''}${error.stderr || ''}${error.message || String(error)}`;
      lastOutput = output;
      if (!isTransientNotarytoolOutput(output) || attempt === MAX_ATTEMPTS) {
        throw new Error(`Notarization failed after ${attempt} attempt(s):\n${output}`);
      }
      const waitMs = attempt * 60 * 1000;
      console.warn(`notarytool transient HTTP error on attempt ${attempt}; retrying in ${Math.round(waitMs / 1000)}s`);
      sleep(waitMs);
    }
  }

  throw new Error(`Notarization failed:\n${lastOutput}`);
}

async function afterSign(context) {
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (shouldSkipNotarization({ platform: context.electronPlatformName, enabled: process.env.REBASE_NOTARIZE, appPath })) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-notarize-'));
  const zipPath = path.join(tmpDir, `${appName}.zip`);
  try {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.basename(appPath), zipPath], {
      cwd: path.dirname(appPath),
      stdio: 'inherit',
    });
    const result = submitWithRetry(zipPath);
    console.log(`Notarization accepted: ${result.id || 'no-id'}`);
    run('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = afterSign;
module.exports.isTransientNotarytoolOutput = isTransientNotarytoolOutput;
module.exports.shouldSkipNotarization = shouldSkipNotarization;
module.exports.notarytoolArgs = notarytoolArgs;
