import {readlinkSync, statSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const environment = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC'};

/** OS-only identity; command bytes are hashed and never returned to diagnostics. */
export function inspectLaunchBirth(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return {state: 'unknown'};
    const info = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=,ppid=,pgid=,stat=,command='],
        {env: environment, encoding: 'utf8', timeout: 1500, maxBuffer: 65536});
    if (info.error || info.signal) return {state: 'unknown'};
    if (info.status === 1 && !info.stdout.trim() && !info.stderr.trim()) return {state: 'ended'};
    const match = /^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(info.stdout.trim());
    if (info.status !== 0 || !match || !Number.isFinite(Date.parse(match[1]))) return {state: 'unknown'};
    if (match[4].startsWith('Z')) return {state: 'ended'};
    return {state: 'observed', pid, birth: match[1], ppid: Number(match[2]), pgid: Number(match[3]),
        commandSha256: createHash('sha256').update(match[5]).digest('hex')};
}

/** Birth, cwd, command, group and stdout/stderr descriptors form one bounded observation. */
export function inspectLaunchProcess(pid) {
    const before = inspectLaunchBirth(pid);
    if (before.state !== 'observed') return before;
    try {
        let cwd, outputs;
        if (process.platform === 'linux') {
            cwd = readlinkSync('/proc/' + pid + '/cwd'); outputs = [1, 2].map(fd => statSync('/proc/' + pid + '/fd/' + fd));
        } else if (process.platform === 'darwin') {
            const value = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd,1,2', '-FpfDin'],
                {env: environment, encoding: 'utf8', timeout: 1500, maxBuffer: 65536});
            if (value.error || value.status !== 0 || value.signal) return {state: 'unknown'};
            const rows = []; let row;
            for (const line of value.stdout.split('\n')) {
                if (line.startsWith('f')) { row = {fd: line.slice(1)}; rows.push(row); }
                else if (row && line.startsWith('n')) row.name = line.slice(1);
                else if (row && line.startsWith('D')) row.dev = Number(line.slice(1));
                else if (row && line.startsWith('i')) row.ino = Number(line.slice(1));
            }
            cwd = rows.find(item => item.fd === 'cwd')?.name; outputs = ['1', '2'].map(fd => rows.find(item => item.fd === fd));
        } else return {state: 'unknown'};
        if (!path.isAbsolute(cwd ?? '')) return {state: 'unknown'};
        const after = inspectLaunchBirth(pid);
        if (after.state !== 'observed' || after.birth !== before.birth || after.ppid !== before.ppid
            || after.pgid !== before.pgid || after.commandSha256 !== before.commandSha256) return {state: 'unknown'};
        return {...before, cwd, outputs: outputs.map(item => Number.isSafeInteger(item?.dev) && Number.isSafeInteger(item?.ino) ? {dev: item.dev, ino: item.ino} : null)};
    } catch { return {state: 'unknown'}; }
}
