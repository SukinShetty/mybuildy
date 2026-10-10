import { test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from './projects-core';
function setup(t: TestContext) { const root = mkdtempSync(join(tmpdir(), 'mybuildy-fix-')); t.onTestFinished(() => rmSync(root, { recursive: true, force: true })); let n = 0; const deps = { newId: () => `id-${++n}`, now: () => new Date().toISOString() }; const first = p.ensureProjectsInitialized(root, deps); const second = p.createProject(root, { name: 'B' }, deps); p.renameProjectRecord(root, first.activeProjectId, 'A'); return { root, deps, first, second }; }
test('truncation refuses initialization, retains bytes and never creates another project', t => { const { root, deps, second } = setup(t); const broken = '{"projects":'; writeFileSync(p.projectsFilePath(root), broken); assert.throws(() => p.ensureProjectsInitialized(root, deps), p.isProjectsRecoveryError); assert.equal(readFileSync(p.projectsFilePath(root), 'utf8'), broken); assert.equal(readdirSync(join(root, 'mybuildy-memory')).length, 2); assert.equal(p.readProjectsBackup(root)!.projects.length, 2); });
test('explicit backup restore preserves exact damaged bytes and original active identity', t => { const { root, deps, second } = setup(t); const backup = p.readProjectsBackup(root); writeFileSync(p.projectsFilePath(root), 'BROKEN-BYTES\n'); const restored = p.restoreProjectsBackup(root); assert.deepEqual(restored, backup); assert.equal(restored.activeProjectId, second.project.id); const copies = readdirSync(root).filter(x => x.startsWith('projects.json.damaged-')); assert.equal(copies.length, 1); assert.equal(readFileSync(join(root, copies[0]), 'utf8'), 'BROKEN-BYTES\n'); assert.deepEqual(p.ensureProjectsInitialized(root, deps), backup); });
test('damaged primary cannot poison a last-good backup on save', t => { const { root, second } = setup(t); const before = readFileSync(p.projectsBackupPath(root), 'utf8'); writeFileSync(p.projectsFilePath(root), '{'); assert.throws(() => p.saveProjectsFile(root, second.file), p.isProjectsRecoveryError); assert.equal(readFileSync(p.projectsBackupPath(root), 'utf8'), before); assert.equal(readFileSync(p.projectsFilePath(root), 'utf8'), '{'); });
test('missing registry with backup requires explicit recovery', t => { const { root, deps } = setup(t); rmSync(p.projectsFilePath(root)); assert.throws(() => p.ensureProjectsInitialized(root, deps), p.isProjectsRecoveryError); assert.equal(existsSync(p.projectsFilePath(root)), false); });
test('missing registry without backup but with memory folders refuses reset', t => { const { root, deps } = setup(t); rmSync(p.projectsFilePath(root)); rmSync(p.projectsBackupPath(root)); assert.throws(() => p.ensureProjectsInitialized(root, deps), p.isProjectsRecoveryError); assert.equal(existsSync(p.projectsFilePath(root)), false); });
test('malformed active identity never silently chooses another project', t => { const { root, second } = setup(t); writeFileSync(p.projectsFilePath(root), JSON.stringify({ ...second.file, activeProjectId: 'unknown' })); assert.throws(() => p.loadProjectsFile(root), p.isProjectsRecoveryError); });
test('100 writes produce readable primary and backup with no temp leftovers', t => { const { root, first } = setup(t); for (let i = 0; i < 100; i++) {
    p.renameProjectRecord(root, first.activeProjectId, 'A' + i);
    assert.ok(p.loadProjectsFile(root));
    assert.ok(p.readProjectsBackup(root));
} assert.equal(readdirSync(root).filter(x => x.endsWith('.tmp')).length, 0); });
test('unreadable primary is not treated as a first run', t => { const { root, deps } = setup(t); rmSync(p.projectsFilePath(root)); mkdirSync(p.projectsFilePath(root)); assert.throws(() => p.ensureProjectsInitialized(root, deps), p.isProjectsRecoveryError); });
test('invalid backup cannot be restored over original', t => { const { root } = setup(t); writeFileSync(p.projectsFilePath(root), 'primary-damaged'); writeFileSync(p.projectsBackupPath(root), 'backup-damaged'); assert.throws(() => p.restoreProjectsBackup(root), p.isProjectsRecoveryError); assert.equal(readFileSync(p.projectsFilePath(root), 'utf8'), 'primary-damaged'); });
test('failed primary rename preserves previous registry and removes staged temp', async (t) => { const { root, first } = setup(t); const before = readFileSync(p.projectsFilePath(root), 'utf8'); const fs = await import('node:fs'); const { syncBuiltinESMExports } = await import('node:module'); const original = fs.default.renameSync; fs.default.renameSync = (from, to) => { if (to === p.projectsFilePath(root)) {
    throw Object.assign(new Error('Injected rename failure'), { code: 'EACCES' });
} return original(from, to); }; syncBuiltinESMExports(); try {
    assert.throws(() => p.renameProjectRecord(root, first.activeProjectId, 'should not persist'), /Injected rename failure/);
}
finally {
    fs.default.renameSync = original;
    syncBuiltinESMExports();
} assert.equal(readFileSync(p.projectsFilePath(root), 'utf8'), before); assert.equal(readdirSync(root).filter(x => x.endsWith('.tmp')).length, 0); assert.ok(p.readProjectsBackup(root)); });
