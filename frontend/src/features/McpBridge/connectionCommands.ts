function siteOrigin(origin: string): string {
    const site = new URL(origin);
    if (!['http:', 'https:'].includes(site.protocol)) { throw new Error('Для подключения нужен HTTP(S)-адрес Нейроцентра.'); }
    return site.origin;
}

const quote = (value: string, windows: boolean): string => value.replace(/'/g, windows ? "''" : "'\"'\"'");

/** Подключает имеющийся автономный мост к текущей площадке без скачивания и регистрации заново. */
export function installedBridgeCommand(origin: string, windows: boolean, reconnect = false): string {
    const quoted = quote(siteOrigin(origin), windows);
    const option = reconnect ? '--reconnect-open' : '--connect-open';
    if (windows) {
        return `$env:NEUROCENTER_URL='${quoted}'; & "$env:USERPROFILE/.opencode/neurocenter-asset-sync/bin/node.exe" "$env:USERPROFILE/.opencode/neurocenter-asset-sync/dist/index.js" ${option}`;
    }
    const directory = '${INSTALL_DIR:-$HOME/.opencode/neurocenter-asset-sync}';
    return `NEUROCENTER_URL='${quoted}' "${directory}/bin/node" "${directory}/dist/index.js" ${option}`;
}

/** Команда установки использует выбранную ОС и адрес открытой площадки. */
export function bridgeInstallerCommand(origin: string, windows: boolean, reconnect = false): string {
    const url = quote(`${siteOrigin(origin)}/api/bridge/install.${windows ? 'ps1' : 'sh'}${reconnect ? '?reconnect=1' : ''}`, windows);
    return windows ? `irm '${url}' | iex` : `curl -fsSL '${url}' | bash`;
}
