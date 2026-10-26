function siteOrigin(origin: string): string {
    const site = new URL(origin);
    if (!['http:', 'https:'].includes(site.protocol)) { throw new Error('Для подключения нужен HTTP(S)-адрес Нейроцентра.'); }
    return site.origin;
}

const quote = (value: string, windows: boolean): string => value.replace(/'/g, windows ? "''" : "'\"'\"'");

/** Restore legacy PowerShell TLS policy before executing the downloaded bootstrap. */
function bootstrapCommand(url: string, windows: boolean): string {
    if (!windows) { return `curl -fsSL --insecure '${url}' | bash`; }
    return `& { $u='${url}'; if ($PSVersionTable.PSVersion.Major -ge 7) { $s=irm -SkipCertificateCheck -Uri $u -ErrorAction Stop } else { if (-not ('NeurocenterBootstrapTls' -as [type])) { Add-Type 'public static class NeurocenterBootstrapTls { public static readonly System.Net.Security.RemoteCertificateValidationCallback Accept = delegate { return true; }; }' }; $p=[Net.ServicePointManager]::ServerCertificateValidationCallback; try { [Net.ServicePointManager]::ServerCertificateValidationCallback=[NeurocenterBootstrapTls]::Accept; $s=irm -Uri $u -ErrorAction Stop } finally { [Net.ServicePointManager]::ServerCertificateValidationCallback=$p } }; $s | iex }`;
}

/** Сценарий выбранного Gateway подключает существующий автономный мост к этой площадке. */
export function installedBridgeCommand(origin: string, windows: boolean, reconnect = false): string {
    const url = quote(`${siteOrigin(origin)}/api/bridge/connect.${windows ? 'ps1' : 'sh'}${reconnect ? '?reconnect=1' : ''}`, windows);
    return bootstrapCommand(url, windows);
}

/** Команда установки использует выбранную ОС и публичный адрес API Gateway. */
export function bridgeInstallerCommand(origin: string, windows: boolean, reconnect = false): string {
    const url = quote(`${siteOrigin(origin)}/api/bridge/install.${windows ? 'ps1' : 'sh'}${reconnect ? '?reconnect=1' : ''}`, windows);
    return bootstrapCommand(url, windows);
}

/** OpenCode скачивается через тот же публичный Gateway, что и мост. */
export function openCodeInstallerCommand(origin:string,windows:boolean):string {
    const url=quote(`${siteOrigin(origin)}/api/bridge/install_opencode.${windows?'ps1':'sh'}`,windows);
    return bootstrapCommand(url, windows);
}
