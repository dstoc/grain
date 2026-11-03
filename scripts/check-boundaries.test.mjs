import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repositoryRoot, 'scripts/check-boundaries.mjs');

function checkCommand(source) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'grain-boundaries-'));
  try {
    const canonicalPath = path.join(fixture, 'src/markdown/canonical/document.ts');
    const commandPath = path.join(fixture, 'src/editing/commands/probe.ts');
    mkdirSync(path.dirname(canonicalPath), { recursive: true });
    mkdirSync(path.dirname(commandPath), { recursive: true });
    writeFileSync(canonicalPath, 'export class CanonicalDocument {}\n');
    writeFileSync(commandPath, source);
    return spawnSync(process.execPath, [checker], { cwd: fixture, encoding: 'utf8' });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('boundary checker source scanning', () => {
  it('rejects ordinary literal dynamic imports across the canonical boundary', () => {
    const result = checkCommand("void import('../../markdown/canonical/document.js');");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /depends on canonical implementation/);
  });

  it('rejects literal dynamic imports with options', () => {
    const result = checkCommand("void import('../../markdown/canonical/document.js', {});");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /depends on canonical implementation/);
  });

  it('rejects static template literal dynamic imports', () => {
    const result = checkCommand('void import(`../../markdown/canonical/document.js`);');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /depends on canonical implementation/);
  });

  it('rejects direct browser globals in commands', () => {
    const result = checkCommand('void document.title;');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uses browser global document/);
  });

  it('rejects browser globals accessed through globalThis', () => {
    const result = checkCommand('void globalThis.document.title;');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uses browser global document/);
  });

  it('rejects browser globals accessed through optional globalThis', () => {
    const result = checkCommand('void globalThis?.document.title;');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uses browser global document/);
  });

  it('allows an ordinary object property named document', () => {
    const result = checkCommand('void editor.document.title;');
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });
});
