'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * AD-OP-6 (OQ-2): fail-closed проверка владельцев writable-томов при старте сервиса.
 *
 * Non-root-образ (uid 1000) не может автоматически chown старый root-owned named volume
 * и не должен молча работать в read-only-состоянии: каждый writable-корень тома обязан
 * принадлежать uid сервиса. Старый том (созданный до non-root-миграции) даёт явную
 * ошибку с действием — согласованный backup, затем пересоздание тома в новом пустом
 * стеке + restore либо одноразовый chown uid=1000 через привилегированный контейнер
 * (docs/production-setup.md, AD-OP-6), а не тихий fail.
 *
 * Действует только в production (NODE_ENV=production): dev-стенд с host-bind-mount'ами
 * под другим uid — поддерживаемая конфигурация, проверке не подлежит.
 * Пустые позиции пропускаются: отсутствующая переменная означает image-owned fallback
 * (принадлежит service-user по chown в Dockerfile), а не том.
 *
 * @param {string} service Имя сервиса для сообщения об ошибке.
 * @param {Array<string | undefined>} roots Writable-корни томов (значения env или image-пути).
 */
function assertServiceVolumes(service, roots) {
    if (process.env.NODE_ENV !== 'production') return;
    const uid = process.getuid();
    const problems = [];
    for (const raw of roots) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const root = path.resolve(raw);
        let stat;
        try {
            stat = fs.lstatSync(root);
        } catch (error) {
            problems.push(
                'каталог ' + root + ' недоступен (' + (error && error.code ? error.code : 'ошибка доступа') + ')',
            );
            continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            problems.push(root + ' не является каталогом');
            continue;
        }
        if (stat.uid !== uid) {
            problems.push('каталог ' + root + ' принадлежит uid=' + stat.uid + ', сервис работает от uid=' + uid);
            continue;
        }
        try {
            fs.accessSync(root, fs.constants.W_OK);
        } catch {
            problems.push('каталог ' + root + ' недоступен для записи');
        }
    }
    if (!problems.length) return;
    throw new Error(
        '[' +
            service +
            '] владельцы writable-томов (AD-OP-6): ' +
            problems.join('; ') +
            '. ' +
            'Старые root-owned тома (созданные до non-root-миграции) не поддерживаются: ' +
            'сделайте согласованный backup, затем пересоздайте том (новый пустой стек + restore) ' +
            'либо выполните одноразовый chown uid=1000 через привилегированный контейнер. ' +
            'Подробности — docs/production-setup.md (AD-OP-6).',
    );
}

module.exports = { assertServiceVolumes };
