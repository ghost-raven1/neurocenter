import path from 'node:path';
import { load } from 'js-yaml';
import type { Package } from '../../bridge/package.js';
import { ProbeError } from './model.js';

/** Проверяет описание и локальные ссылки скилла, не импортируя и не запуская его ресурсы. */
export function checkSkill(pkg: Package): void {
    const file = pkg.files.find(item => item.path === 'SKILL.md');
    if (!file || file.encoding) { throw new ProbeError('needs_configuration', 'invalid-skill'); }
    const match = file.content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    let metadata: Record<string, unknown>;
    try { metadata = load(match?.[1] ?? '') as Record<string, unknown>; }
    catch { throw new ProbeError('needs_configuration', 'invalid-skill'); }
    if (!metadata || metadata.name !== pkg.plugin.name || pkg.plugin.name.length > 64
        || typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024) {
        throw new ProbeError('needs_configuration', 'invalid-skill');
    }
    const files = new Set(pkg.files.map(item => item.path));
    for (const link of file.content.matchAll(/!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) {
        const raw = link[1] ?? '';
        if (!raw || raw.startsWith('#') || /^(?:https?|mailto):/i.test(raw)) { continue; }
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) { throw new ProbeError('needs_configuration', 'invalid-skill'); }
        let target: string;
        try { target = decodeURIComponent(raw.split(/[?#]/)[0] ?? ''); }
        catch { throw new ProbeError('needs_configuration', 'invalid-skill'); }
        target = path.posix.normalize(target.replace(/^\.\//, ''));
        if (target.startsWith('/') || target === '..' || target.startsWith('../') || !files.has(target)) {
            throw new ProbeError('needs_configuration', 'invalid-skill');
        }
    }
}
