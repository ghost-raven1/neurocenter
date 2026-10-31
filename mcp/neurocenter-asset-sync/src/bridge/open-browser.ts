import { execFile } from 'node:child_process';

/** Открытие ссылки использует аргументы процесса без shell и не подтверждает доступ за пользователя. */
export function browserCommand(url: string, platform: string): { file: string; args: string[] } {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\r\n]/.test(url)) {
        throw new Error('Небезопасная ссылка подключения.');
    }
    if (platform === 'darwin') {
        return { file: 'open', args: [url] };
    }
    if (platform === 'win32') {
        return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
    }
    return { file: 'xdg-open', args: [url] };
}
export async function openVerificationPage(url: string): Promise<boolean> {
    if (process.env.NEUROCENTER_NO_BROWSER === '1') {
        return false;
    }
    const command = browserCommand(url, process.platform);
    return new Promise((resolve) =>
        execFile(command.file, command.args, { timeout: 5000, windowsHide: true }, (error) => resolve(!error)),
    );
}
