#!/usr/bin/env node
/**
 * scripts/check-syntax.mjs
 *
 * Stand-in for a build step, since this project has none. Walks src/ and
 * backend/, and runs `node --check` (parse-only, does not execute or
 * resolve imports) on every .js/.mjs file it finds. Fails the process with
 * a non-zero exit code — and a list of offending files — on any syntax
 * error.
 *
 * This lets each task verify their files load without a bundler or test
 * runner: `npm run check`.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SCAN_DIRS = ['src', 'backend'];
const JS_EXTENSIONS = new Set(['.js', '.mjs']);
const IGNORE_DIR_NAMES = new Set(['node_modules', '.git']);

/**
 * @param {string} dir
 * @returns {string[]} absolute paths of matching files
 */
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (IGNORE_DIR_NAMES.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      const dotIndex = entry.name.lastIndexOf('.');
      const ext = dotIndex === -1 ? '' : entry.name.slice(dotIndex);
      if (JS_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

/**
 * Runs `node --check <file>` in a child process. This only parses the
 * file — it does not execute top-level code or resolve import specifiers —
 * so files with static imports of not-yet-created sibling modules still
 * pass, as expected for scaffolding.
 * @param {string} filePath
 * @returns {Promise<{ok: boolean, stderr: string}>}
 */
function checkFile(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, stderr });
    });

    child.on('error', (err) => {
      resolve({ ok: false, stderr: String(err) });
    });
  });
}

async function main() {
  const targets = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

  if (targets.length === 0) {
    console.log('check-syntax: no .js/.mjs files found under', SCAN_DIRS.join(', '));
    return;
  }

  const failures = [];
  for (const filePath of targets) {
    const { ok, stderr } = await checkFile(filePath);
    if (!ok) {
      failures.push({ filePath, stderr });
    }
  }

  const relPaths = targets.map((f) => relative(ROOT, f));
  console.log(`check-syntax: checked ${targets.length} file(s):`);
  for (const p of relPaths) console.log(`  - ${p}`);

  if (failures.length > 0) {
    console.error(`\ncheck-syntax: ${failures.length} file(s) failed to parse:\n`);
    for (const { filePath, stderr } of failures) {
      console.error(`--- ${relative(ROOT, filePath)} ---`);
      console.error(stderr.trim());
      console.error('');
    }
    process.exitCode = 1;
    return;
  }

  console.log('\ncheck-syntax: all files parsed successfully.');
}

main();
