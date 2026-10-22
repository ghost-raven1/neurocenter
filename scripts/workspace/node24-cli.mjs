import {spawn} from 'node:child_process';
import {constants} from 'node:os';
import {nodeRuntime} from './node-runtime.mjs';

/** Use the installed project runtime; keep arguments, exit status and cancellation across a Node upgrade. */
export async function launchNode24(entry, args = process.argv.slice(2), {killGraceMs = 15000} = {}) {
    const runtime = nodeRuntime();
    process.exitCode = await new Promise((resolve, reject) => {
        const child = spawn(runtime.node, [entry, ...args], {env: runtime.env, stdio: 'inherit',
            detached: process.platform !== 'win32', shell: false});
        let cancelled, timer;
        const signalGroup = signal => {
            if (!child.pid) return;
            try {
                if (process.platform === 'win32') child.kill(signal);
                else process.kill(-child.pid, signal);
            } catch (error) { if (error.code !== 'ESRCH') reject(error); }
        };
        const cancel = signal => {
            cancelled ??= signal;
            signalGroup(signal);
            timer ??= setTimeout(() => signalGroup('SIGKILL'), killGraceMs);
        };
        const interrupt = () => cancel('SIGINT'), terminate = () => cancel('SIGTERM');
        const clean = () => {
            signalGroup('SIGKILL');
            clearTimeout(timer);
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
        };
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        child.once('error', error => { clean(); reject(error); });
        child.once('close', (code, signal) => {
            clean();
            resolve(cancelled || signal ? 128 + (constants.signals[cancelled || signal] || 1) : code ?? 1);
        });
    });
}
