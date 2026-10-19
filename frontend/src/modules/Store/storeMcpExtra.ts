import { invalidArtifactMetadata, packageRuntimeArtifacts } from '../../features/McpBridge/runtimeArtifacts';

const object = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string,unknown>, keys: string[]) => Object.keys(value).every(key=>keys.includes(key));
const forbiddenEnv = /^(HOME|USERPROFILE|PATH|SHELL|ENV|BASH_ENV|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_PATH|XDG_.*|OPENCODE_.*|BUN_.*|NPM_.*|PIP_.*|PYTHON.*|LD_.*|DYLD_.*)$/i;
const portablePath = (value:string) => !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part=>part&&part!=='.'&&part!=='..'
    && !/[<>:"|?*\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part));

function configurationSchema(value:unknown,transport:unknown):void {
    if(!object(value) || !exact(value,['schemaVersion','fields']) || value.schemaVersion!==1 || !Array.isArray(value.fields)
        || !value.fields.length || value.fields.length>32) {throw new Error('localConfiguration: укажите schemaVersion: 1 и от 1 до 32 полей без значений параметров.');}
    const ids=new Set<string>();const targets=new Set<string>();
    for(const field of value.fields){
        if(!object(field) || !exact(field,['id','label','type','required','secret','target']) || typeof field.id!=='string' || !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(field.id)
            || ids.has(field.id) || typeof field.label!=='string' || !field.label.trim() || field.label.length>160 || /[\x00-\x1f]/.test(field.label)
            || !['string','url','number','boolean'].includes(String(field.type)) || typeof field.required!=='boolean'
            || field.secret!==undefined&&typeof field.secret!=='boolean' || !object(field.target) || !exact(field.target,['kind','name','prefix'])
            || !['env','header'].includes(String(field.target.kind)) || typeof field.target.name!=='string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/.test(field.target.name)
            || field.target.kind==='env'&&(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field.target.name)||forbiddenEnv.test(field.target.name))
            || field.target.kind==='header'&&(transport!=='remote'||/^(host|content-length|connection|transfer-encoding|cookie|proxy-authorization)$/i.test(field.target.name))
            || field.target.prefix!==undefined&&(typeof field.target.prefix!=='string'||field.target.prefix.length>64||/[\x00-\x1f\x7f]/.test(field.target.prefix))) {
            throw new Error('localConfiguration: проверьте описание полей и назначение env/header. Значения, секреты и опасные переменные в схеме не допускаются.');
        }
        const target=field.target.kind+':'+(field.target.kind==='header'?field.target.name.toLowerCase():field.target.name);
        if(targets.has(target)){throw new Error('localConfiguration: два поля не могут задавать один параметр.');}
        ids.add(field.id);targets.add(target);
    }
}

/** JSON-редактор сохраняет валидный контракт 0.9, не превращая extra в произвольное хранилище. */
export function editMcpExtra(config:Record<string,unknown>):boolean {
    if(config.extra===undefined)return false;
    if(!object(config.extra)||!exact(config.extra,['runtimeArtifacts','localConfiguration'])) {
        throw new Error('Поддерживаются поля extra.runtimeArtifacts и extra.localConfiguration. Зависимости задаются отдельно.');
    }
    if(invalidArtifactMetadata({config})){throw new Error('runtimeArtifacts: проверьте платформу, SHA-256, размеры, число файлов и точку входа готового комплекта.');}
    const artifacts=packageRuntimeArtifacts({config});
    if(artifacts.some(value=>!exact(value as unknown as Record<string,unknown>,['target','sha256','compressedBytes','unpackedBytes','filesCount','entrypoint','executable'])
        || !portablePath(value.entrypoint) || value.executable!==undefined&&typeof value.executable!=='boolean')) {
        throw new Error('runtimeArtifacts: допускаются только переносимые пути и закреплённые метаданные, без URL и команд установки.');
    }
    if(artifacts.length){
        if(config.transport==='remote'){throw new Error('Удалённый MCP использует URL; готовый локальный комплект для него не поддерживается.');}
        if(config.entrypoint!==undefined&&!artifacts.every(value=>value.entrypoint===config.entrypoint)) {throw new Error('Точка входа entrypoint должна совпадать с готовыми комплектами; для разных платформ уберите общее поле.');}
        if(config.command!==undefined&&(config.command!=='node'||artifacts.some(value=>value.executable===true))) {throw new Error('Готовый комплект сам задаёт запуск. Поле command можно опустить; node допустим только для JavaScript-комплектов.');}
    }
    if(config.extra.localConfiguration!==undefined)configurationSchema(config.extra.localConfiguration,config.transport);
    return artifacts.length>0;
}
