import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Helper принимается только из собственного runtime и по закреплённому SHA; системные команды kill не используются. */
export async function windowsJobHelper():Promise<string|undefined> {
    if (process.platform !== 'win32') {return undefined;}
    const root = path.dirname(path.dirname(process.execPath)); let handle;
    try {
        const metadata = JSON.parse(await fs.readFile(path.join(root,'runtime.json'),'utf8')) as {windowsJobHelper?:{file:string;sha256:string}};
        const item = metadata.windowsJobHelper;
        if (item?.file !== 'bin/neurocenter-job.exe' || !/^[a-f0-9]{64}$/.test(item.sha256)) {return undefined;}
        const target = path.join(root,item.file); const before = await fs.lstat(target);
        if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > 4*1024*1024) {return undefined;}
        handle = await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW); const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev) {return undefined;}
        const bytes = await handle.readFile(); const after = await handle.stat();
        if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {return undefined;}
        return target;
    } catch {return undefined;} finally {await handle?.close();}
}
