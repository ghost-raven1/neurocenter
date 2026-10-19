/** Закреплённый выпуск и полный набор платформенных npm-пакетов OpenCode. */
export const opencodeVersion = '1.14.48';
export const opencodeVariants = Object.freeze([
    'darwin-arm64', 'darwin-x64', 'darwin-x64-baseline',
    'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl', 'linux-x64-baseline', 'linux-x64-baseline-musl',
    'windows-arm64', 'windows-x64', 'windows-x64-baseline',
]);

/** Автоматическая установка выбирает baseline для x64, включая процессоры без AVX2. */
export function opencodePackageName(platform = process.platform, arch = process.arch, musl = false) {
    const os = {darwin: 'darwin', linux: 'linux', win32: 'windows'}[platform];
    const variant = `${os}-${arch}${arch === 'x64' ? '-baseline' : ''}${musl ? '-musl' : ''}`;
    if (!opencodeVariants.includes(variant)) throw new Error('Unsupported probe target');
    return `opencode-${variant}`;
}
