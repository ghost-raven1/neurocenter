import { createHash } from 'node:crypto';
import { canonicalV4 } from '../../bridge/package.js';

export interface LocalConfigurationField {
    id: string; label: string; type: 'string' | 'url' | 'number' | 'boolean'; required: boolean; secret?: boolean;
    target: {kind: 'env' | 'header'; name: string; prefix?: string};
}
export interface LocalConfigurationSchema {schemaVersion: 1; fields: LocalConfigurationField[]}
export type ConfigurationValues = Record<string, string | number | boolean>;
const forbiddenEnv = /^(HOME|USERPROFILE|PATH|SHELL|ENV|BASH_ENV|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_PATH|XDG_.*|OPENCODE_.*|BUN_.*|NPM_.*|PIP_.*|PYTHON.*|LD_.*|DYLD_.*)$/i;
const exact = (value: Record<string,unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** Схема не допускает исполняемые шаблоны, опасные переменные или неоднозначные назначения. */
export function parseLocalConfiguration(pkg: {plugin: {kind: string}; config: unknown}): LocalConfigurationSchema | undefined {
    const config = pkg.config as {extra?: {localConfiguration?: unknown}; transport?: string} | null;
    const source = config?.extra?.localConfiguration;
    if (source === undefined) {return undefined;}
    const schema = source as LocalConfigurationSchema;
    if (pkg.plugin.kind !== 'mcp' || !schema || !exact(schema as unknown as Record<string,unknown>, ['schemaVersion','fields'])
        || schema.schemaVersion !== 1 || !Array.isArray(schema.fields) || !schema.fields.length || schema.fields.length > 32) {throw new Error('Некорректная схема локальной настройки.');}
    const ids = new Set<string>(); const targets = new Set<string>();
    for (const field of schema.fields) {
        if (!field || !exact(field as unknown as Record<string,unknown>, ['id','label','type','required','secret','target'])
            || typeof field.id !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(field.id) || ids.has(field.id)
            || typeof field.label !== 'string' || !field.label.trim() || field.label.length > 160 || /[\x00-\x1f]/.test(field.label)
            || !['string','url','number','boolean'].includes(field.type) || typeof field.required !== 'boolean'
            || field.secret !== undefined && typeof field.secret !== 'boolean' || !field.target
            || !exact(field.target as unknown as Record<string,unknown>, ['kind','name','prefix'])
            || !['env','header'].includes(field.target.kind) || typeof field.target.name !== 'string'
            || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/.test(field.target.name)
            || ['__proto__','prototype','constructor'].includes(field.target.name.toLowerCase())
            || field.target.kind === 'env' && (config?.transport === 'remote' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field.target.name) || forbiddenEnv.test(field.target.name))
            || field.target.kind === 'header' && (config?.transport !== 'remote' || /^(host|content-length|connection|transfer-encoding|cookie|proxy-authorization)$/i.test(field.target.name))
            || field.target.prefix !== undefined && (typeof field.target.prefix !== 'string' || field.target.prefix.length > 64 || /[\x00-\x1f\x7f]/.test(field.target.prefix))) {throw new Error('Некорректное поле локальной настройки.');}
        const target = field.target.kind + ':' + (field.target.kind === 'header' ? field.target.name.toLowerCase() : field.target.name);
        if (targets.has(target)) {throw new Error('Параметры настройки имеют одинаковое назначение.');}
        ids.add(field.id); targets.add(target);
    }
    return structuredClone(schema);
}
export function localConfigurationDigest(schema: LocalConfigurationSchema): string {
    return createHash('sha256').update(JSON.stringify(canonicalV4(schema))).digest('hex');
}
/** Пустое значение удаляет параметр; неизвестные поля и управляющие символы отклоняются. */
export function validateConfigurationValues(schema: LocalConfigurationSchema, input: unknown): ConfigurationValues {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) {throw new Error('Некорректные значения настройки.');}
    const values: ConfigurationValues = {};
    for (const [id, value] of Object.entries(input)) {
        const field = schema.fields.find(item => item.id === id);
        if (!field) {throw new Error('Неизвестный параметр настройки.');}
        if (value === '' || value === null) {continue;}
        if (field.type === 'boolean' ? typeof value !== 'boolean' : field.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value)
            : typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {throw new Error('Недопустимое значение параметра.');}
        if (field.type === 'url') {try {const url = new URL(value as string); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) {throw new Error();}} catch {throw new Error('Некорректный URL параметра.');}}
        Object.defineProperty(values,id,{value,enumerable:true,writable:true,configurable:true});
    }
    return values;
}
export const missingConfigurationFields = (schema: LocalConfigurationSchema, values: ConfigurationValues): string[] => schema.fields.filter(field => field.required && !Object.hasOwn(values,field.id)).map(field => field.id);
export function configurationTargets(schema: LocalConfigurationSchema, values: ConfigurationValues): {env: Record<string,string>; headers: Record<string,string>} {
    const result = {env:{} as Record<string,string>,headers:{} as Record<string,string>};
    for (const field of schema.fields) {if (Object.hasOwn(values,field.id)) {
        Object.defineProperty(result[field.target.kind === 'env' ? 'env' : 'headers'],field.target.name,
            {value:(field.target.prefix ?? '') + String(values[field.id]),enumerable:true,writable:true,configurable:true});
    }}
    return result;
}
