import { constants as flags, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const markerName = 'neurocenter-agent-kit.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shaPattern = /^[a-f0-9]{64}$/;
const skillPattern = /^skills\/(neurocenter-[a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/;
const rolePattern = /^agents\/(neurocenter-[a-z0-9]+(?:-[a-z0-9]+)*)\.toml$/;
const legacySkillPattern = /^skills\/(aleksei-[a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/;
const legacyRolePattern = /^agents\/(aleksei-[a-z0-9]+(?:-[a-z0-9]+)*)\.toml$/;

/** Reject links and non-directory ancestors before reading or writing a kit path. */
function inspect(file, directory = false) {
  const parts = path.resolve(file).split(path.sep).filter(Boolean);
  let current = path.parse(path.resolve(file)).root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink() || ((i < parts.length - 1 || directory) ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Unsafe kit path: ${current}`);
    }
    if (i === parts.length - 1) return stat;
  }
  throw new Error('Filesystem root is not a kit destination');
}

function read(file, optional = false) {
  if (!inspect(file)) {
    if (optional) return null;
    throw new Error(`Missing kit file: ${file}`);
  }
  const fd = openSync(file, flags.O_RDONLY | flags.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 4 * 1024 * 1024) throw new Error(`Invalid kit file: ${file}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..') || path.isAbsolute(value)) {
    throw new Error(`Invalid manifest path: ${value}`);
  }
  return value;
}

function destination(source) {
  safeRelative(source);
  if (source.startsWith('.opencode/skills/')) {
    const target = source.slice('.opencode/'.length);
    if (skillPattern.test(target)) return target;
  }
  if (source.startsWith('scripts/agent-kit/codex/')) {
    const target = `agents/${source.slice('scripts/agent-kit/codex/'.length)}`;
    if (rolePattern.test(target)) return target;
  }
  if (/^\.opencode\/agents\/neurocenter-[a-z0-9-]+\.md$/.test(source) || /^\.opencode\/commands\/[a-z0-9-]+\.md$/.test(source)) return null;
  throw new Error(`Unknown manifest path: ${source}`);
}

function previousOwner(file, legacy = false) {
  const bytes = read(file, true);
  if (!bytes) return { bytes, files: {} };
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== 1 || typeof value.version !== 'string' || !shaPattern.test(value.manifestHash) || !value.files || Array.isArray(value.files)) throw new Error('Invalid installed kit receipt');
  for (const [name, hash] of Object.entries(value.files)) {
    safeRelative(name);
    if ((!(legacy ? legacySkillPattern : skillPattern).test(name) && !(legacy ? legacyRolePattern : rolePattern).test(name)) || !shaPattern.test(hash)) throw new Error('Invalid installed kit ownership');
  }
  return { bytes, files: value.files };
}

/** Migrate only still-identical files explicitly owned by the previous personal kit. */
function legacyPlan(codexHome, selected) {
  const file = path.join(codexHome, 'aleksei-agent-kit.json');
  const owner = previousOwner(file, true);
  const files = Object.entries(owner.files).map(([relative, hash]) => {
    const renamed = relative.replace(/^(skills|agents)\/aleksei-/, '$1/neurocenter-');
    if (!selected.has(renamed)) throw new Error(`Legacy file has no renamed counterpart: ${relative}`);
    const target = path.join(codexHome, relative);
    const bytes = read(target, true);
    if (bytes && digest(bytes) !== hash) throw new Error(`Modified legacy user file preserved: ${target}`);
    return { relative, target, bytes };
  });
  return { file, owner, files };
}

/** Delete verified obsolete bytes, pruning empty skill directories but preserving manual neighbours. */
function removeOwnedFiles(files, home, skillPrefix) {
  const directories = new Set();
  for (const file of files) {
    unchanged(file.target, file.bytes);
    if (file.bytes) unlinkSync(file.target);
    let directory = path.posix.dirname(file.relative);
    while (directory.startsWith(skillPrefix)) {
      directories.add(path.join(home, directory));
      directory = path.posix.dirname(directory);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    if (!inspect(directory, true)) continue;
    try { rmdirSync(directory); } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}

function removeLegacy(plan) {
  removeOwnedFiles(plan.files, path.dirname(plan.file), 'skills/aleksei-');
  if (plan.owner.bytes) {
    for (const file of plan.files) unchanged(file.target, null);
    unchanged(plan.file, plan.owner.bytes);
    unlinkSync(plan.file);
  }
}

function unchanged(file, expected) {
  const current = read(file, true);
  if ((current === null) !== (expected === null) || (current && !current.equals(expected))) throw new Error(`Kit path changed during installation: ${file}`);
}

function writeAtomic(file, bytes, expected, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true });
  inspect(path.dirname(file), true);
  unchanged(file, expected);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode });
    unchanged(file, expected);
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Plan or install verified personal skills and roles without changing Codex configuration. */
export function installCodexKit({ kitRoot = repoRoot, codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'), apply = false, check = false, environment = process.env } = {}) {
  const retirementFlag = environment.NEUROCENTER_AGENT_KIT_RETIRE;
  if (retirementFlag !== undefined && !['0', '1'].includes(retirementFlag)) throw new Error('NEUROCENTER_AGENT_KIT_RETIRE must be 0 or 1');
  const retirementEnabled = retirementFlag !== '0';
  if (apply && check) throw new Error('Choose either --apply or --check');
  kitRoot = path.resolve(kitRoot);
  codexHome = path.resolve(codexHome);
  inspect(kitRoot, true);
  inspect(codexHome, true);
  const manifestBytes = read(path.join(kitRoot, 'scripts/agent-kit/manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || manifest.roleCount !== 64 || typeof manifest.version !== 'string' || !manifest.version || !manifest.files || Array.isArray(manifest.files)) throw new Error('Invalid agent kit manifest');
  const ownerFile = path.join(codexHome, markerName);
  const owner = previousOwner(ownerFile);
  const files = [];
  for (const [source, hash] of Object.entries(manifest.files)) {
    const relative = destination(source);
    if (!shaPattern.test(hash)) throw new Error(`Invalid manifest hash: ${source}`);
    if (!relative) continue;
    const bytes = read(path.join(kitRoot, source));
    if (digest(bytes) !== hash) throw new Error(`Kit integrity mismatch: ${source}`);
    const target = path.join(codexHome, relative);
    const existing = read(target, true);
    const same = existing?.equals(bytes) ?? false;
    if (existing && !same && owner.files[relative] !== digest(existing)) throw new Error(`Existing user file preserved: ${target}`);
    files.push({ relative, target, bytes, hash, existing, state: same ? 'unchanged' : existing ? 'updated' : 'created' });
  }
  const skills = new Set(files.filter((file) => file.relative.endsWith('/SKILL.md')).map((file) => file.relative.split('/')[1]));
  const roles = files.filter((file) => rolePattern.test(file.relative));
  if (skills.size !== 65 || !skills.has('neurocenter-task-flow') || roles.length !== 64 || roles.some((file) => !skills.has(path.basename(file.relative, '.toml'))) || files.some((file) => file.relative.startsWith('skills/') && !skills.has(file.relative.split('/')[1]))) throw new Error('The kit must contain 64 roles, their skills, and the common task flow');
  const legacy = legacyPlan(codexHome, new Set(files.map((file) => file.relative)));
  const selected = new Set(files.map((file) => file.relative));
  const obsolete = Object.entries(owner.files).filter(([relative]) => !selected.has(relative)).map(([relative, hash]) => {
    const target = path.join(codexHome, relative), bytes = read(target, true);
    if (bytes && digest(bytes) !== hash) throw new Error(`Modified obsolete user file preserved: ${target}`);
    return { relative, target, bytes };
  });
  const manifestHash = digest(manifestBytes);
  const retained = Object.fromEntries(Object.entries(owner.files).filter(([relative]) => selected.has(relative)));
  const receipt = Buffer.from(`${JSON.stringify({ schemaVersion: 1, version: manifest.version, manifestHash, files: { ...retained, ...Object.fromEntries(files.map((file) => [file.relative, file.hash])) } }, null, 2)}\n`);
  if (check && (files.some((file) => file.state !== 'unchanged') || !owner.bytes?.equals(receipt) || legacy.owner.bytes || obsolete.length)) throw new Error('The installed kit is missing, differs from the verified source, or requires legacy migration'+(obsolete.length?`; obsolete: ${obsolete.map((file) => file.relative).join(', ')}`:''));
  if (apply) {
    if (!retirementEnabled && obsolete.length) throw new Error(`NEUROCENTER_AGENT_KIT_RETIRE=0 blocks installation requiring retirement: ${obsolete.map((file) => file.relative).join(', ')}`);
    for (const file of files) unchanged(file.target, file.existing);
    unchanged(ownerFile, owner.bytes);
    for (const file of legacy.files) unchanged(file.target, file.bytes);
    for (const file of obsolete) unchanged(file.target, file.bytes);
    unchanged(legacy.file, legacy.owner.bytes);
    for (const file of files) if (file.state !== 'unchanged') writeAtomic(file.target, file.bytes, file.existing);
    for (const file of files) unchanged(file.target, file.bytes);
    removeOwnedFiles(obsolete, codexHome, 'skills/neurocenter-');
    removeLegacy(legacy);
    if (!owner.bytes?.equals(receipt)) writeAtomic(ownerFile, receipt, owner.bytes, 0o600);
  }
  return { mode: check ? 'check' : apply ? 'apply' : 'plan', version: manifest.version, manifestHash, codexHome, retirementEnabled, skillCount: skills.size, roleCount: roles.length, fileCount: files.length, legacyFiles: legacy.files.filter((file) => file.bytes).map((file) => file.relative), obsolete: obsolete.map((file) => file.relative), changed: files.filter((file) => file.state !== 'unchanged').map((file) => file.relative), ...Object.fromEntries(['created', 'updated', 'unchanged'].map((state) => [state, files.filter((file) => file.state === state).length])) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--apply' && arg !== '--check') || new Set(args).size !== args.length) throw new Error('Usage: node scripts/agent-kit/install-codex.mjs [--apply | --check]');
    console.log(JSON.stringify(installCodexKit({ apply: args.includes('--apply'), check: args.includes('--check') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
