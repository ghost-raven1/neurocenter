function siteOrigin(origin: string): string {
    const site = new URL(origin);
    if (!['http:', 'https:'].includes(site.protocol)) { throw new Error('Для подключения нужен HTTP(S)-адрес Нейроцентра.'); }
    return site.origin;
}

const quote = (value: string, windows: boolean): string => value.replace(/'/g, windows ? "''" : "'\"'\"'");

/** Подключает имеющийся автономный мост к текущей площадке без скачивания и регистрации заново. */
export function installedBridgeCommand(origin: string, windows: boolean, reconnect = false): string {
    siteOrigin(origin);
    const option = reconnect ? ' --reconnect' : '';
    if (windows) {
        return `& "$env:USERPROFILE/.local/bin/neurocenter-bridge.cmd" connect --open${option}`;
    }
    return `"\${HOME}/.local/bin/neurocenter-bridge" connect --open${option}`;
}

/** Команда установки использует выбранную ОС и публичный адрес API Gateway. */
export function bridgeInstallerCommand(origin: string, windows: boolean, reconnect = false): string {
    const url = quote(`${siteOrigin(origin)}/api/bridge/install.${windows ? 'ps1' : 'sh'}${reconnect ? '?reconnect=1' : ''}`, windows);
    return windows ? `irm '${url}' | iex` : `curl -fsSL '${url}' | bash`;
}

/** OpenCode скачивается через тот же публичный Gateway, что и мост. */
export function openCodeInstallerCommand(origin:string,windows:boolean):string {
    const url=quote(`${siteOrigin(origin)}/api/bridge/install_opencode.${windows?'ps1':'sh'}`,windows);
    return windows?`irm '${url}' | iex`:`curl -fsSL '${url}' | bash`;
}
