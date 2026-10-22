function siteOrigin(origin: string): string {
    const site = new URL(origin);
    if (!['http:', 'https:'].includes(site.protocol)) { throw new Error('Для подключения нужен HTTP(S)-адрес Нейроцентра.'); }
    return site.origin;
}

const quote = (value: string, windows: boolean): string => value.replace(/'/g, windows ? "''" : "'\"'\"'");

/** Сценарий выбранного Gateway подключает существующий автономный мост к этой площадке. */
export function installedBridgeCommand(origin: string, windows: boolean, reconnect = false): string {
    const url = quote(`${siteOrigin(origin)}/api/bridge/connect.${windows ? 'ps1' : 'sh'}${reconnect ? '?reconnect=1' : ''}`, windows);
    return windows ? `irm '${url}' | iex` : `curl -fsSL '${url}' | bash`;
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
