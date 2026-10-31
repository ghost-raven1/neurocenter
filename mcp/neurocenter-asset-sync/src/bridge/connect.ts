import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openVerificationPage } from './open-browser.js';
import { ensureCurrentWorker } from './worker-upgrade.js';
import { api, hash, hub, readState, stateDir, writeState, type Credentials } from './state.js';

const index = fileURLToPath(new URL('../index.js', import.meta.url));
export function startWorker(): void {
    const child = spawn(process.execPath, [index, '--worker'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
    });
    child.unref();
}
interface Pair {
    deviceCode: string;
    userCode: string;
    expiresIn: number;
    candidateToken?: string;
    fingerprint?: string;
    expiresAt?: number;
}
interface Identity {
    id: string;
    email: string;
    role: string;
}
function startPairWatch(): void {
    const child = spawn(process.execPath, [index, '--pair-watch'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
    });
    child.unref();
}
async function pairLink(pair: Pair, openBrowser: boolean) {
    startPairWatch();
    const url = `${hub()}/start?setup=1&setupFlow=bridge-first&step=0&connect=${encodeURIComponent(pair.userCode)}`;
    const browserOpened = openBrowser ? await openVerificationPage(url) : false;
    return {
        url,
        code: pair.userCode,
        fingerprint: pair.fingerprint,
        expiresIn: Math.max(0, Math.floor(((pair.expiresAt || Date.now() + 600000) - Date.now()) / 1000)),
        browserOpened,
        note: 'Проверьте имя и отпечаток компьютера и подтвердите подключение в браузере. Код нужен только если ссылка не открылась.',
    };
}
async function connected(token: string, identity: Identity) {
    await writeState('credentials', { token, deviceId: identity.id, email: identity.email });
    await fs.rm(path.join(stateDir(), 'pair.json'), { force: true });
    await ensureCurrentWorker();
    startWorker();
    return {
        connected: true,
        deviceId: identity.id,
        note: 'Компьютер уже подключён. Продолжите настройку OpenCode на странице «Начало работы».',
    };
}
/** Клиент хранит будущий ключ до подтверждения; повтор poll не теряет секрет и сохраняет прежний ID устройства. */
export async function connectBridge(openBrowser = false, reconnect = false) {
    const pending = await readState<Pair>('pair');
    if (pending?.candidateToken) {
        let identity: Identity | undefined;
        try {
            identity = await api<Identity>('identity', undefined, pending.candidateToken);
        } catch {
            /* Ключ ещё не подтверждён; продолжаем тот же шаг подключения. */
        }
        if (identity) {
            return connected(pending.candidateToken, identity);
        }
        if ((pending.expiresAt || 0) > Date.now()) {
            return pairLink(pending, openBrowser);
        }
    }
    const credentials = await readState<Credentials>('credentials');
    if (credentials && !reconnect) {
        let identity: Identity | undefined;
        try {
            identity = await api<Identity>('identity');
        } catch {
            /* Продление просроченного подключения требует повторного подтверждения владельца. */
        }
        if (identity) {
            return connected(credentials.token, identity);
        }
    }
    const candidateToken = randomBytes(32).toString('hex');
    const fingerprint = hash(randomBytes(32).toString('hex'));
    const pair = await api<Pair>('pair/start', {
        name: os.hostname(),
        fingerprint,
        credentialHash: hash(candidateToken),
    });
    const saved = { ...pair, candidateToken, fingerprint, expiresAt: Date.now() + pair.expiresIn * 1000 };
    await writeState('pair', saved);
    return pairLink(saved, openBrowser);
}
export async function watchPair(): Promise<void> {
    const pair = await readState<Pair>('pair');
    if (!pair) {
        return;
    }
    const started = Date.now();
    while (Date.now() - started < 600000 && Date.now() < (pair.expiresAt || started + 600000)) {
        try {
            const response = await api<Credentials & { state: string }>('pair/poll', { deviceCode: pair.deviceCode });
            if (response.state === 'connected') {
                const current = await readState<Pair>('pair');
                if (current?.deviceCode !== pair.deviceCode) {
                    return;
                }
                const token = pair.candidateToken || response.token;
                if (!token) {
                    throw new Error('Подключение не содержит локального ключа. Обновите MCP и повторите подключение.');
                }
                await writeState('credentials', { token, deviceId: response.deviceId, email: response.email });
                await fs.rm(path.join(stateDir(), 'pair.json'), { force: true });
                await ensureCurrentWorker();
                startWorker();
                return;
            }
        } catch (error) {
            process.stderr.write((error as Error).message + '\n');
        }
        await new Promise((resolve) => setTimeout(resolve, 2500));
    }
}
