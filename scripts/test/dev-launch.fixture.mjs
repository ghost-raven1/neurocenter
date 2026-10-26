import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {launchDevService} from '../workspace/dev-launch-provenance.mjs';
import {stopWatchGroup} from '../workspace/dev-watch-owned.mjs';

export async function launchFixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc launch proof '))), records = [];
    const logDir = path.join(root, '.run/logs'), service = {name: 'catalog', dir: 'services/catalog-service'};
    await fs.mkdir(logDir, {recursive: true}); await fs.mkdir(path.join(root, service.dir, 'dist'), {recursive: true});
    await fs.mkdir(path.join(root, 'scripts/workspace'), {recursive: true});
    for (const name of ['dev-launch-ack.mjs', 'dev-watch-child.mjs']) await fs.copyFile(new URL('../workspace/' + name, import.meta.url), path.join(root, 'scripts/workspace', name));
    const entry = path.join(root, service.dir, 'dist/main.js');
    await fs.writeFile(entry, 'console.log(JSON.stringify({launchId:process.env.NEUROCENTER_DEV_LAUNCH_ID??null}));setInterval(()=>{},1000);');
    t.after(async () => { await Promise.allSettled(records.map(record => stopWatchGroup(record))); await fs.rm(root, {recursive: true, force: true}); });
    const launch = async (options = {}) => {
        const {environment, onOwner, ...settings} = options;
        const value = await launchDevService({root, node: process.execPath, service, entry, logDir,
            environment: {PATH: process.env.PATH, PRIVATE_TEST_TOKEN: 'NEVER_IN_RECEIPT', ...environment}, ...settings,
            onOwner: record => { records.push(record); onOwner?.(record); }});
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) { if ((await fs.stat(value.logFile)).size) break; await delay(20); }
        return value;
    };
    return {root, logDir, service, entry, launch, records,
        receipt: id => path.join(root, '.run/dev-launches/catalog', id + '.json')};
}
