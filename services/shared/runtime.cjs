'use strict';
const fs = require('node:fs');
const path = require('node:path');

const secretNames = ['SNAPSHOT_S3_ACCESS_KEY', 'SNAPSHOT_S3_SECRET_KEY', 'SNAPSHOT_VERIFIER_TOKEN', 'RESTORE_RUNNER_TOKEN', 'NEUROCENTER_MODEL_CREDENTIAL_KEY', 'NEUROCENTER_METRICS_TOKEN', 'NEUROCENTER_INTERNAL_TOKEN', 'SSO_CLIENT_SECRET', 'CATALOG_PG_URL', 'RAG_PG_URL', 'RAG_PROVISION_PG_URL'];
const services = new Set(['api-gateway', 'catalog-service', 'skills-service', 'rag-sync-service', 'feature-flags-service', 'oauth2-bridge', 'bootstrap-admin']);

/** Читает только известные секреты; ошибка не раскрывает ни путь, ни значение. */
function loadSecrets(env) {
    for (const name of secretNames) {
        if (!env[name + '_FILE']) { continue; }
        if (env[name]) { throw new Error('Задайте только ' + name + '_FILE, без ' + name); }
        let value;
        try {
            const filename = env[name + '_FILE'];
            const stat = fs.statSync(filename);
            if (!stat.isFile() || stat.size > 65536) { throw new Error('format'); }
            value = fs.readFileSync(filename, 'utf8').replace(/\r?\n$/, '');
        } catch { throw new Error('Не удалось прочитать секрет ' + name); }
        if (!value || /[\x00\r\n]/.test(value)) { throw new Error('Некорректный секрет ' + name); }
        env[name] = value;
    }
}

function required(env, name) {
    const value = env[name];
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) { throw new Error('Заполните ' + name); }
    return value;
}

/** Проверяет публичные URL без доверия к Host и forwarded-заголовкам. */
function httpsUrl(value, name, originOnly = false) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Некорректный ' + name); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== '/')) {
        throw new Error(name + ' должен быть доверенным HTTPS URL' + (originOnly ? ' без пути' : ''));
    }
    return url;
}

/** Production завершается до подключения к БД при неполных или dev-настройках. */
function validateProduction(env, service) {
    if (env.NODE_ENV !== 'production') { return; }
    if (env.RESTORE_RUNNER_TOKEN !== undefined && !/^[a-f0-9]{64,128}$/.test(required(env,'RESTORE_RUNNER_TOKEN'))) { throw new Error('RESTORE_RUNNER_TOKEN: нужны 32 или более случайных байта в hex'); }
    if (!services.has(service)) { throw new Error('Неизвестный NEUROCENTER_SERVICE'); }
    if (env.NEUROCENTER_METRICS_TOKEN !== undefined && !/^[a-f0-9]{64,128}$/.test(required(env, 'NEUROCENTER_METRICS_TOKEN'))) {
        throw new Error('NEUROCENTER_METRICS_TOKEN: нужны 32 или более случайных байта в hex');
    }
    for (const flag of ['SSO_DISABLE', 'RAG_AUTH_DISABLED']) {
        if (env[flag] !== undefined && env[flag] !== 'false') { throw new Error(flag + '=false обязателен в production'); }
    }
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') { throw new Error('Запрещено отключать проверку TLS'); }
    const panel = service==='bootstrap-admin'?null:httpsUrl(required(env, 'PANEL_URL'), 'PANEL_URL', true);
    if (service!=='bootstrap-admin'&&!/^[a-f0-9]{64,128}$/.test(required(env, 'NEUROCENTER_INTERNAL_TOKEN'))) { throw new Error('NEUROCENTER_INTERNAL_TOKEN: нужны 32 или более случайных байта в hex'); }
    for (const name of service === 'catalog-service' ? ['CATALOG_PG_URL', 'RAG_PG_URL'] : ['bootstrap-admin','feature-flags-service'].includes(service)?['CATALOG_PG_URL']:service === 'rag-sync-service' ? ['RAG_PG_URL','RAG_PROVISION_PG_URL'] : []) {
        let url;
        try { url = new URL(required(env, name)); } catch { throw new Error('Некорректный ' + name); }
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || url.pathname.length < 2) { throw new Error('Заполните безопасное подключение ' + name); }
    }
    if (service === 'oauth2-bridge') {
        if (env.SSO_DISABLE !== 'false') { throw new Error('Заполните SSO_DISABLE=false'); }
        httpsUrl(required(env, 'SSO_HOST'), 'SSO_HOST');
        required(env, 'SSO_CLIENT_ID'); required(env, 'SSO_CLIENT_SECRET');
        const redirect = httpsUrl(required(env, 'REDIRECT_URI'), 'REDIRECT_URI');
        if (redirect.href !== panel.origin + '/auth/callback') { throw new Error('REDIRECT_URI должен совпадать с PANEL_URL/auth/callback'); }
    }
    if (service === 'catalog-service') {
        let skills;
        try { skills = new URL(required(env, 'SKILLS_SERVICE_URL')); } catch { throw new Error('Заполните SKILLS_SERVICE_URL'); }
        if (!['http:', 'https:'].includes(skills.protocol) || skills.username || skills.password || skills.search || skills.hash || skills.pathname !== '/') {
            throw new Error('SKILLS_SERVICE_URL должен быть адресом сервиса без пути и секретов');
        }
    }
    if (service === 'feature-flags-service') {
        let catalog;
        try { catalog = new URL(required(env, 'CATALOG_SERVICE_URL')); } catch { throw new Error('Заполните CATALOG_SERVICE_URL'); }
        if (!['http:', 'https:'].includes(catalog.protocol) || catalog.username || catalog.password || catalog.search || catalog.hash || catalog.pathname !== '/') {
            throw new Error('CATALOG_SERVICE_URL должен быть адресом сервиса без пути и секретов');
        }
    }
    if (service === 'rag-sync-service' && env.RAG_AUTH_DISABLED !== 'false') { throw new Error('Заполните RAG_AUTH_DISABLED=false'); }
}

module.exports = {loadSecrets, validateProduction, httpsUrl};
loadSecrets(process.env);
const inferred = path.basename(path.resolve(process.argv[1] || '.', '..', '..'));
validateProduction(process.env, process.env.NEUROCENTER_SERVICE || inferred);
