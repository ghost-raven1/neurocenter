import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installCodexKit } from '../install-codex.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sourceRole = 'scripts/agent-kit/codex/neurocenter-role-63.toml';
const targetRole = 'agents/neurocenter-role-63.toml';
const core = '.opencode/skills/neurocenter-task-flow/SKILL.md';
const installer = fileURLToPath(new URL('../install-codex.mjs', import.meta.url));

function put(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/** Every fixture is a disposable kit and a private, initially absent Codex home. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nc-agent-kit-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kitRoot = path.join(root, 'kit');
  const codexHome = path.join(root, 'codex');
  const manifest = { schemaVersion: 1, version: '0.1.0', roleCount: 64, files: {} };
  const add = (name, text) => {
    put(path.join(kitRoot, name), text);
    manifest.files[name] = hash(text);
  };
  add(core, 'Common task flow\n');
  add('.opencode/skills/neurocenter-task-flow/references/verification.md', 'Verification\n');
  for (let number = 0; number < 64; number += 1) {
    add(`.opencode/skills/neurocenter-role-${number}/SKILL.md`, `Role skill ${number}\n`);
    add(`scripts/agent-kit/codex/neurocenter-role-${number}.toml`, `name = "neurocenter-role-${number}"\n`);
  }
  add('.opencode/agents/neurocenter-explorer.md', 'Project only agent\n');
  add('.opencode/commands/task-flow.md', 'Project only command\n');
  const save = () => put(path.join(kitRoot, 'scripts/agent-kit/manifest.json'), `${JSON.stringify(manifest)}\n`);
  save();
  return { root, kitRoot, codexHome, manifest, add, save, run: (options = {}) => installCodexKit({ kitRoot, codexHome, ...options }) };
}

function snapshot(root) {
  if (!existsSync(root)) return null;
  const output = {};
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const key = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(file, { bigint: true });
      output[key] = [String(stat.mode), String(stat.mtimeNs), stat.isFile() ? hash(readFileSync(file)) : stat.isSymbolicLink() ? 'link' : 'directory'];
      if (stat.isDirectory()) visit(file, key);
    }
  }
  visit(root);
  return output;
}

function legacyInstallation(f) {
  const files = {};
  for (const [source] of Object.entries(f.manifest.files)) {
    let relative;
    if (source.startsWith('.opencode/skills/')) relative = source.slice('.opencode/'.length);
    else if (source.startsWith('scripts/agent-kit/codex/')) relative = `agents/${path.basename(source)}`;
    else continue;
    relative = relative.replace(/^(skills|agents)\/neurocenter-/, '$1/aleksei-');
    const bytes = readFileSync(path.join(f.kitRoot, source), 'utf8').replaceAll('neurocenter-', 'aleksei-');
    put(path.join(f.codexHome, relative), bytes);
    files[relative] = hash(bytes);
  }
  put(path.join(f.codexHome, 'aleksei-agent-kit.json'), `${JSON.stringify({ schemaVersion: 1, version: '0.1.0', manifestHash: hash('legacy'), files }, null, 2)}\n`);
  return files;
}

test('planning verifies the complete kit without creating the global home', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.mode, 'plan');
  assert.equal(result.roleCount, 64);
  assert.equal(result.skillCount, 65);
  assert.equal(result.fileCount, 130);
  assert.equal(result.created, 130);
  assert.equal(result.changed.length, 130);
  assert.match(result.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(f.codexHome), false);
});

test('apply installs roles and skills, ignores project adapters, and preserves personal configuration', (t) => {
  const f = fixture(t);
  put(path.join(f.codexHome, 'config.toml'), 'model = "personal"\n');
  put(path.join(f.codexHome, 'auth.json'), 'synthetic private account\n');
  put(path.join(f.codexHome, 'skills/custom/SKILL.md'), 'Personal skill\n');
  const before = snapshot(f.codexHome);
  const result = f.run({ apply: true });
  assert.equal(result.created, 130);
  const after = snapshot(f.codexHome);
  for (const [name, state] of Object.entries(before)) if (name !== 'skills') assert.deepEqual(after[name], state);
  assert.equal(readFileSync(path.join(f.codexHome, targetRole), 'utf8'), readFileSync(path.join(f.kitRoot, sourceRole), 'utf8'));
  assert.equal(existsSync(path.join(f.codexHome, 'commands')), false);
  assert.equal(existsSync(path.join(f.codexHome, '.opencode')), false);
  assert.equal(lstatSync(path.join(f.codexHome, 'neurocenter-agent-kit.json')).mode & 0o777, 0o600);
});

test('repeated apply and check do not rewrite any installed file or receipt', (t) => {
  const f = fixture(t);
  f.run({ apply: true });
  const before = snapshot(f.codexHome);
  assert.equal(f.run({ apply: true }).unchanged, 130);
  assert.deepEqual(f.run({ check: true }).changed, []);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('check detects a missing installation without side effects', (t) => {
  const f = fixture(t);
  assert.throws(() => f.run({ check: true }), /installed kit/);
  assert.equal(existsSync(f.codexHome), false);
});

test('a conflict in the final file prevents every earlier planned write', (t) => {
  const f = fixture(t);
  put(path.join(f.codexHome, targetRole), 'User authored role\n');
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ apply: true }), /Existing user file preserved/);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('an update replaces only bytes proven to belong to the preceding kit', (t) => {
  const f = fixture(t);
  f.run({ apply: true });
  const other = path.join(f.codexHome, 'skills/neurocenter-role-0/SKILL.md');
  const otherState = lstatSync(other, { bigint: true }).mtimeNs;
  f.manifest.version = '0.1.1';
  f.add(sourceRole, 'name = "updated role"\n');
  f.save();
  const result = f.run({ apply: true });
  assert.equal(result.updated, 1);
  assert.equal(result.unchanged, 129);
  assert.equal(readFileSync(path.join(f.codexHome, targetRole), 'utf8'), 'name = "updated role"\n');
  assert.equal(lstatSync(other, { bigint: true }).mtimeNs, otherState);
  assert.deepEqual(f.run({ check: true }).changed, []);
});

test('manual edits to an owned file are preserved and block the whole update', (t) => {
  const f = fixture(t);
  f.run({ apply: true });
  put(path.join(f.codexHome, targetRole), 'User modified installed role\n');
  f.add(core, 'New common flow\n');
  f.add(sourceRole, 'New role\n');
  f.save();
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ apply: true }), /Existing user file preserved/);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('existing identical files are retained and can be adopted without rewriting them', (t) => {
  const f = fixture(t);
  put(path.join(f.codexHome, targetRole), readFileSync(path.join(f.kitRoot, sourceRole)));
  const before = lstatSync(path.join(f.codexHome, targetRole), { bigint: true }).mtimeNs;
  assert.equal(f.run({ apply: true }).unchanged, 1);
  assert.equal(lstatSync(path.join(f.codexHome, targetRole), { bigint: true }).mtimeNs, before);
});

test('source tampering or a missing source cannot partially install the kit', (t) => {
  const f = fixture(t);
  put(path.join(f.kitRoot, sourceRole), 'Corrupted source\n');
  assert.throws(() => f.run({ apply: true }), /integrity mismatch/);
  assert.equal(existsSync(f.codexHome), false);
  rmSync(path.join(f.kitRoot, sourceRole));
  assert.throws(() => f.run({ apply: true }), /Missing kit file/);
  assert.equal(existsSync(f.codexHome), false);
});

for (const kind of ['source file', 'source directory', 'home', 'target directory', 'target file', 'dangling target']) {
  test(`rejects a symbolic link at the ${kind} boundary`, (t) => {
    const f = fixture(t);
    const foreign = path.join(f.root, 'foreign');
    put(path.join(foreign, 'sentinel'), 'Do not touch\n');
    if (kind === 'source file') {
      rmSync(path.join(f.kitRoot, sourceRole));
      symlinkSync(path.join(foreign, 'sentinel'), path.join(f.kitRoot, sourceRole));
    } else if (kind === 'source directory') {
      rmSync(path.join(f.kitRoot, '.opencode/skills'), { recursive: true });
      symlinkSync(foreign, path.join(f.kitRoot, '.opencode/skills'));
    } else if (kind === 'home') symlinkSync(foreign, f.codexHome);
    else {
      mkdirSync(path.join(f.codexHome, 'agents'), { recursive: true });
      if (kind === 'target directory') symlinkSync(foreign, path.join(f.codexHome, 'skills'));
      else symlinkSync(path.join(foreign, kind === 'dangling target' ? 'absent' : 'sentinel'), path.join(f.codexHome, targetRole));
    }
    const before = snapshot(foreign);
    assert.throws(() => f.run({ apply: true }), /Unsafe kit path/);
    assert.deepEqual(snapshot(foreign), before);
  });
}

test('rejects a regular file occupying a required parent directory', (t) => {
  const f = fixture(t);
  put(path.join(f.codexHome, 'skills'), 'Not a directory\n');
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ apply: true }), /Unsafe kit path/);
  assert.deepEqual(snapshot(f.codexHome), before);
});

for (const badPath of ['../outside', '/absolute', '.opencode/skills/neurocenter-task-flow/../escape', '.opencode/skills/neurocenter-task-flow\\escape', 'auth.json', '.opencode/agents/foreign.md']) {
  test(`rejects manifest path ${badPath}`, (t) => {
    const f = fixture(t);
    f.manifest.files[badPath] = hash('Unexpected\n');
    f.save();
    assert.throws(() => f.run({ apply: true }), /manifest path/);
    assert.equal(existsSync(f.codexHome), false);
  });
}

test('rejects wrong counts, absent role skills, orphan skill files, and invalid hashes', (t) => {
  const f = fixture(t);
  f.manifest.roleCount = 63;
  f.save();
  assert.throws(() => f.run(), /Invalid agent kit manifest/);
  f.manifest.roleCount = 64;
  delete f.manifest.files['.opencode/skills/neurocenter-role-63/SKILL.md'];
  f.save();
  assert.throws(() => f.run(), /64 roles/);
  f.add('.opencode/skills/neurocenter-role-63/SKILL.md', 'Restored\n');
  f.add('.opencode/skills/neurocenter-orphan/reference.md', 'Orphan\n');
  f.save();
  assert.throws(() => f.run(), /64 roles/);
  delete f.manifest.files['.opencode/skills/neurocenter-orphan/reference.md'];
  f.manifest.files[core] = 'not-a-sha';
  f.save();
  assert.throws(() => f.run(), /Invalid manifest hash/);
  assert.equal(existsSync(f.codexHome), false);
});

test('an invalid ownership receipt cannot authorize replacement of a foreign file', (t) => {
  const f = fixture(t);
  put(path.join(f.codexHome, targetRole), 'Personal role\n');
  put(path.join(f.codexHome, 'neurocenter-agent-kit.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', manifestHash: hash('x'), files: { '../auth.json': hash('Personal role\n') } }));
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ apply: true }), /Invalid manifest path/);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('check detects stale ownership metadata even when all installed source bytes match', (t) => {
  const f = fixture(t);
  f.run({ apply: true });
  const file = path.join(f.codexHome, 'neurocenter-agent-kit.json');
  const receipt = JSON.parse(readFileSync(file));
  receipt.manifestHash = hash('stale');
  put(file, `${JSON.stringify(receipt, null, 2)}\n`);
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ check: true }), /installed kit/);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('CLI rejects unsupported arguments before touching the requested home', (t) => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [installer, '--apply', '--unknown'], { env: { ...process.env, CODEX_HOME: f.codexHome }, encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Usage:/);
  assert.equal(existsSync(f.codexHome), false);
  assert.throws(() => f.run({ check: true, apply: true }), /Choose either/);
});

test('legacy migration plans without writing, then verifies the new kit before removing owned old files', (t) => {
  const f = fixture(t);
  const files = legacyInstallation(f);
  put(path.join(f.codexHome, 'config.toml'), 'Unchanged personal configuration\n');
  const before = snapshot(f.codexHome);
  assert.equal(f.run().legacyFiles.length, 130);
  assert.deepEqual(snapshot(f.codexHome), before);
  const result = f.run({ apply: true });
  assert.equal(result.legacyFiles.length, 130);
  for (const old of Object.keys(files)) assert.equal(existsSync(path.join(f.codexHome, old)), false);
  assert.equal(existsSync(path.join(f.codexHome, 'skills/aleksei-role-0')), false);
  assert.equal(existsSync(path.join(f.codexHome, 'skills/aleksei-task-flow')), false);
  assert.equal(existsSync(path.join(f.codexHome, 'aleksei-agent-kit.json')), false);
  assert.equal(readFileSync(path.join(f.codexHome, targetRole), 'utf8'), 'name = "neurocenter-role-63"\n');
  assert.equal(readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), 'Unchanged personal configuration\n');
  const after = snapshot(f.codexHome);
  assert.deepEqual(f.run({ check: true }).changed, []);
  assert.deepEqual(f.run({ apply: true }).legacyFiles, []);
  assert.deepEqual(snapshot(f.codexHome), after);
});

test('a modified legacy file prevents all new writes and preserves the whole old installation', (t) => {
  const f = fixture(t);
  legacyInstallation(f);
  put(path.join(f.codexHome, 'agents/aleksei-role-63.toml'), 'Manual legacy modification\n');
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ apply: true }), /Modified legacy user file preserved/);
  assert.deepEqual(snapshot(f.codexHome), before);
  assert.equal(existsSync(path.join(f.codexHome, 'neurocenter-agent-kit.json')), false);
});

test('a new namespace collision cannot delete or change any legacy file', (t) => {
  const f = fixture(t);
  legacyInstallation(f);
  put(path.join(f.codexHome, targetRole), 'Personal new namespace role\n');
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ apply: true }), /Existing user file preserved/);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('migration preserves unowned old namespace files and their containing directories', (t) => {
  const f = fixture(t);
  legacyInstallation(f);
  const manual = path.join(f.codexHome, 'skills/aleksei-role-0/notes/personal.md');
  const other = path.join(f.codexHome, 'agents/aleksei-personal.toml');
  put(manual, 'Manual notes\n');
  put(other, 'Manual unrelated agent\n');
  const before = [readFileSync(manual), readFileSync(other)];
  f.run({ apply: true });
  assert.deepEqual(readFileSync(manual), before[0]);
  assert.deepEqual(readFileSync(other), before[1]);
  assert.equal(existsSync(path.join(f.codexHome, 'aleksei-agent-kit.json')), false);
});

test('migration safely resumes after some owned old files have already disappeared', (t) => {
  const f = fixture(t);
  legacyInstallation(f);
  rmSync(path.join(f.codexHome, 'agents/aleksei-role-63.toml'));
  assert.equal(f.run({ apply: true }).legacyFiles.length, 129);
  assert.deepEqual(f.run({ check: true }).legacyFiles, []);
});

for (const kind of ['legacy file', 'legacy receipt']) {
  test(`migration rejects a symbolic link replacing an owned ${kind}`, (t) => {
    const f = fixture(t);
    legacyInstallation(f);
    const name = kind === 'legacy file' ? 'agents/aleksei-role-63.toml' : 'aleksei-agent-kit.json';
    const file = path.join(f.codexHome, name);
    const foreign = path.join(f.root, 'private-manual-file');
    put(foreign, readFileSync(file));
    rmSync(file);
    symlinkSync(foreign, file);
    const before = snapshot(f.codexHome);
    const foreignBefore = readFileSync(foreign);
    assert.throws(() => f.run({ apply: true }), /Unsafe kit path/);
    assert.deepEqual(snapshot(f.codexHome), before);
    assert.deepEqual(readFileSync(foreign), foreignBefore);
  });
}

test('legacy receipt cannot authorize deleting files outside the renamed source set', (t) => {
  const f = fixture(t);
  const files = legacyInstallation(f);
  files['agents/aleksei-unrelated.toml'] = hash('Unrelated\n');
  put(path.join(f.codexHome, 'agents/aleksei-unrelated.toml'), 'Unrelated\n');
  put(path.join(f.codexHome, 'aleksei-agent-kit.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', manifestHash: hash('legacy'), files }));
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ apply: true }), /no renamed counterpart/);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('check refuses to report completion while a verified legacy receipt still needs cleanup', (t) => {
  const f = fixture(t);
  f.run({ apply: true });
  legacyInstallation(f);
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ check: true }), /requires legacy migration/);
  assert.deepEqual(snapshot(f.codexHome), before);
  assert.equal(f.run({ apply: true }).unchanged, 130);
  assert.deepEqual(f.run({ check: true }).legacyFiles, []);
});

function renameRole(f) {
  const obsolete = ['skills/neurocenter-role-63/SKILL.md', targetRole];
  delete f.manifest.files['.opencode/skills/neurocenter-role-63/SKILL.md'];
  delete f.manifest.files[sourceRole];
  f.add('.opencode/skills/neurocenter-renamed-role/SKILL.md', 'Renamed role skill\n');
  f.add('scripts/agent-kit/codex/neurocenter-renamed-role.toml', 'name = "neurocenter-renamed-role"\n');
  f.save();return obsolete;
}

test('role retirement plans without writes, removes owned outputs, and drops obsolete receipt entries', (t) => {
  const f = fixture(t);f.run({ apply: true });const obsolete = renameRole(f);
  const manual = path.join(f.codexHome, 'skills/neurocenter-role-63/notes.md');put(manual, 'Personal notes\n');
  const before = snapshot(f.codexHome), plan = f.run();
  assert.deepEqual(new Set(plan.obsolete), new Set(obsolete));assert.deepEqual(snapshot(f.codexHome), before);
  assert.throws(() => f.run({ check: true }), /obsolete.*neurocenter-role-63/i);assert.deepEqual(snapshot(f.codexHome), before);
  assert.deepEqual(f.run({ apply: true }).obsolete, plan.obsolete);
  for (const name of obsolete) assert.equal(existsSync(path.join(f.codexHome, name)), false);
  assert.equal(readFileSync(manual, 'utf8'), 'Personal notes\n');
  const receipt = JSON.parse(readFileSync(path.join(f.codexHome, 'neurocenter-agent-kit.json')));
  for (const name of obsolete) assert.equal(Object.hasOwn(receipt.files, name), false);
  const after = snapshot(f.codexHome);assert.deepEqual(f.run({ apply: true }).obsolete, []);
  assert.deepEqual(f.run({ check: true }).changed, []);assert.deepEqual(snapshot(f.codexHome), after);
});

for (const conflict of ['modified', 'link', 'parent link']) test(`an obsolete ${conflict} blocks the complete installation before writes`, (t) => {
  const f = fixture(t);f.run({ apply: true });const obsolete = renameRole(f), target = path.join(f.codexHome, obsolete[0]);
  if (conflict === 'modified') put(target, 'My obsolete role\n');
  else {
    const foreign = path.join(f.root, 'foreign');put(path.join(foreign, 'SKILL.md'), readFileSync(target));
    if (conflict === 'link') { rmSync(target);symlinkSync(path.join(foreign, 'SKILL.md'), target); }
    else { rmSync(path.dirname(target), { recursive: true });symlinkSync(foreign, path.dirname(target)); }
  }
  const before = snapshot(f.codexHome);
  assert.throws(() => f.run({ apply: true }), /Modified obsolete user file preserved|Unsafe kit path/);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('absent obsolete outputs are removed from ownership and permit a retry', (t) => {
  const f = fixture(t);f.run({ apply: true });const obsolete = renameRole(f);
  rmSync(path.join(f.codexHome, obsolete[0]));
  assert.deepEqual(new Set(f.run({ apply: true }).obsolete), new Set(obsolete));
  assert.deepEqual(f.run({ check: true }).obsolete, []);
});

test('an established receipt order remains unchanged when no owned paths retire', (t) => {
  const f = fixture(t);f.run({ apply: true });const file = path.join(f.codexHome, 'neurocenter-agent-kit.json');
  const receipt = JSON.parse(readFileSync(file));receipt.files = Object.fromEntries(Object.entries(receipt.files).reverse());
  put(file, `${JSON.stringify(receipt, null, 2)}\n`);const before = snapshot(f.codexHome);
  assert.deepEqual(f.run({ check: true }).obsolete, []);assert.deepEqual(f.run({ apply: true }).changed, []);
  assert.deepEqual(snapshot(f.codexHome), before);
});

test('disabled retirement preserves every installed byte and ownership entry until re-enabled', (t) => {
  const f = fixture(t);f.run({ apply: true });const obsolete = renameRole(f);
  const manual = path.join(f.codexHome, 'skills/neurocenter-role-63/notes.md');put(manual, 'Personal notes\n');
  rmSync(path.join(f.codexHome, obsolete[0]));f.add(core, 'Updated common task flow\n');f.save();
  const environment = { NEUROCENTER_AGENT_KIT_RETIRE: '0' }, before = snapshot(f.root), plan = f.run({ environment });
  assert.equal(plan.retirementEnabled, false);assert.deepEqual(new Set(plan.obsolete), new Set(obsolete));
  assert.throws(() => f.run({ check: true, environment }), /obsolete.*neurocenter-role-63/i);
  assert.throws(() => f.run({ apply: true, environment }), /NEUROCENTER_AGENT_KIT_RETIRE=0/);
  assert.deepEqual(snapshot(f.root), before);
  const applied = f.run({ apply: true, environment: { NEUROCENTER_AGENT_KIT_RETIRE: '1' } });
  assert.equal(applied.retirementEnabled, true);assert.deepEqual(new Set(applied.obsolete), new Set(obsolete));
  assert.equal(readFileSync(manual, 'utf8'), 'Personal notes\n');
  const after = snapshot(f.root);assert.deepEqual(f.run({ apply: true }).obsolete, []);
  assert.deepEqual(f.run({ check: true }).changed, []);assert.deepEqual(snapshot(f.root), after);
});

test('disabled retirement permits installation and updates without obsolete ownership', (t) => {
  const f = fixture(t), environment = { NEUROCENTER_AGENT_KIT_RETIRE: '0' };
  assert.equal(f.run({ apply: true, environment }).retirementEnabled, false);
  f.add(core, 'Updated common task flow\n');f.save();
  assert.equal(f.run({ apply: true, environment }).updated, 1);
  assert.deepEqual(f.run({ check: true, environment }).changed, []);
});

test('invalid retirement flags fail before filesystem input is used and write nothing', (t) => {
  const f = fixture(t), before = snapshot(f.root);let pathCalls = 0;
  const inaccessibleRoot = { toString() { pathCalls += 1;throw Error('Filesystem input must not be used'); } };
  for (const value of ['', 'true', '2', '01', ' 1', '1 ', 1, null]) {
    const environment = { NEUROCENTER_AGENT_KIT_RETIRE: value };
    assert.throws(() => installCodexKit({ kitRoot: inaccessibleRoot, codexHome: f.codexHome, apply: true, environment }), /NEUROCENTER_AGENT_KIT_RETIRE must be 0 or 1/);
    assert.throws(() => f.run({ apply: true, environment }), /NEUROCENTER_AGENT_KIT_RETIRE must be 0 or 1/);
  }
  assert.equal(pathCalls, 0);assert.deepEqual(snapshot(f.root), before);
});
