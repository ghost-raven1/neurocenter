'use strict';

const eventFields = ['id', 'at', 'actor', 'action', 'resourceId', 'source', 'before', 'after'];
const summaryFields = ['generation', 'version', 'sha256'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid = () => new TypeError('Аудит скиллов: нужны до 200 событий с UUID, временем, исполнителем, путём и проверенными сводками версий.');

function exactObject(value, fields) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function summary(value) {
    if (value === null) { return null; }
    if (!exactObject(value, summaryFields)
        || typeof value.generation !== 'string' || !value.generation.trim() || value.generation.length > 128 || /[\u0000-\u001f\u007f]/.test(value.generation)
        || !Number.isSafeInteger(value.version) || value.version < 1
        || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) { throw invalid(); }
    return { generation: value.generation, version: value.version, sha256: value.sha256 };
}

/** Нормализует только безопасные сводки; текст скилла и произвольные поля в журнал не попадают. */
function normalizeSkillAuditEvents(raw) {
    if (!exactObject(raw, ['events']) || !Array.isArray(raw.events) || raw.events.length > 200) { throw invalid(); }
    const seen = new Map();
    return raw.events.map(event => {
        if (!exactObject(event, eventFields)
            || typeof event.id !== 'string' || !uuid.test(event.id)
            || typeof event.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.at)
            || !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at
            || typeof event.actor !== 'string' || (event.actor !== 'skills-service' && (event.actor.length > 254 || !/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/.test(event.actor)))
            || !['skill.create', 'skill.update', 'skill.delete', 'skill.directory.create'].includes(event.action)
            || typeof event.resourceId !== 'string' || !event.resourceId || event.resourceId.length > 240
            || event.resourceId.split('/').some(part => !/^[a-z0-9][a-z0-9_-]*$/.test(part))
            || !['editor', 'sync', 'bootstrap'].includes(event.source)) { throw invalid(); }
        const directory = event.action === 'skill.directory.create';
        if (directory && (event.source !== 'editor' || event.before !== null
            || !exactObject(event.after, ['directory']) || event.after.directory !== true)) { throw invalid(); }
        const before = directory ? null : summary(event.before);
        const after = directory ? { directory: true } : summary(event.after);
        if ((event.action === 'skill.create' && (before !== null || after === null))
            || (event.action === 'skill.update' && (before === null || after === null))
            || (event.action === 'skill.delete' && (before === null || after !== null))) { throw invalid(); }
        const normalized = { id: event.id.toLowerCase(), at: event.at, actor: event.actor, action: event.action,
            resourceId: event.resourceId, source: event.source, before, after };
        const serialized = JSON.stringify(normalized);
        if (seen.has(normalized.id) && seen.get(normalized.id) !== serialized) {
            throw new TypeError('Один UUID события аудита не может содержать разные данные.');
        }
        seen.set(normalized.id, serialized);
        return normalized;
    });
}

module.exports = { normalizeSkillAuditEvents };
