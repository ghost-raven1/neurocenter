import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {nodeRuntime} from '../workspace/node-runtime.mjs';

const directory = fileURLToPath(new URL('./', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const [command, ...parameters] = process.argv.slice(2);
const commands = { build: 'build.mjs', publish: 'publish.mjs', prepare: 'prepare.mjs' };
if (!Object.hasOwn(commands, command) && command !== 'check') throw new Error('Команды: build, publish, prepare, check.');
const runtime = nodeRuntime();
const node = runtime.node;
const tests = () => [...['test', 'recipes/test'].flatMap(folder => fs.readdirSync(path.join(directory, folder)).filter(file => file.endsWith('.test.mjs')).map(file => path.join(directory, folder, file))), path.join(root, 'scripts/test/catalog-plugin-publish.test.mjs')];
const args = command === 'check' ? ['--test', ...tests(), ...parameters] : [path.join(directory, commands[command]), ...parameters];
const child = spawn(node, args, { cwd: root, env: runtime.env, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
