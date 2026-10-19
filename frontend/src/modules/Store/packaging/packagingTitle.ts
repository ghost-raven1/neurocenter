/** Scoped npm имя остаётся узнаваемым и не содержит запрещённого в каталоге разделителя пути. */
export function defaultPackagingTitle(packageName: string): string {
    return packageName.replace(/^@/, '').replace(/\//g, ' · ').trim();
}

/** Пользовательское название проверяется до постановки тяжёлой сборки в очередь. */
export function packagingTitle(override: string, suggested: string): string {
    const title = (override.trim() || defaultPackagingTitle(suggested) || 'Мой инструмент').normalize('NFC');
    if (title.length > 128 || /[\x00-\x1f\x7f/\\]/.test(title) || /^ai-plug-/i.test(title)
        || ['__proto__', 'prototype', 'constructor'].includes(title)) throw new Error('Название — до 128 символов, без / и \\. Префикс ai-plug- зарезервирован.');
    return title;
}
