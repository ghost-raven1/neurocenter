import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildPackage, type IPackage } from '../src/catalog/bundle-package';
import {
    assertInstallablePackage, installationRef, installationSetHash, packageDependencies,
    resolveInstallationSet, verifyInstallationSet, type IInstallationSet,
} from '../src/devices/installation-set';

const project = 'prj-own';
const ref = installationRef;
const remote = (id: string, version = 1, dependencies: IPackage[] = []) => buildPackage(
    { kind: 'mcp', id: `ai-plug-${id}`, name: id, version }, [], 'now',
    { transport: 'remote', url: `https://${id}.example.test/mcp`, ...(dependencies.length ? {
        extra: { requirements: { mcp: [], plugins: [], dependencies: dependencies.map(ref) } },
    } : {}) },
);
const skill = (dependencies: IPackage[] = [], files = [{ path: 'SKILL.md', content: 'Инструкция' }]) => buildPackage(
    { kind: 'skill', id: 'common/helper', name: 'helper', version: 1 }, files, 'now',
    { extra: { requirements: { mcp: [], plugins: [], ...(dependencies.length ? { dependencies: dependencies.map(ref) } : {}) } } },
);
const setOf = (root: IPackage, packages: IPackage[] = [root]): IInstallationSet => ({
    schemaVersion: 1, root: ref(root), packages, manifest: installationSetHash(ref(root), packages),
});
const poolFor = (packages: IPackage[], selectedProject = project) => {
    const allowed = new Set(packages.map(pkg => `${selectedProject}:${pkg.plugin.kind}:${pkg.plugin.id}`));
    return { query: vi.fn(async (_sql: unknown, parameters: unknown[]) => ({
        rows: [], rowCount: allowed.has(parameters.join(':')) ? 1 : 0,
    })) } as unknown as Pool;
};
const builderFor = (packages: IPackage[]) => vi.fn(async (kind: string, id: string, version: number) => {
    const found = packages.find(pkg => pkg.plugin.kind === kind && pkg.plugin.id === id && pkg.plugin.version === version);
    if (!found) { throw new Error('Нет закреплённой версии'); }
    return found;
});
const files = (count: number, bytes = 1) => Array.from({ length: count }, (_, i) => ({ path: `assets/${i}.txt`, content: 'x'.repeat(bytes) }));
const pluginPackage = (id: string, packageFiles: Array<{path: string; content: string}>) => buildPackage(
    {kind:'plugin',id:`ai-plug-${id}`,name:id,version:1},packageFiles,'now',{entrypoint:packageFiles[0]?.path},
);

describe('Замкнутый граф установочного комплекта', () => {
    it('Собирает точную вложенную версию и общую зависимость скачивает один раз', async () => {
        const shared = remote('shared', 2);
        const left = remote('left', 1, [shared]);
        const right = remote('right', 3, [shared]);
        const root = skill([left, right]);
        const build = builderFor([shared, left, right]);
        const result = await resolveInstallationSet(poolFor([root, shared, left, right]), project, root, build);
        expect(result?.packages).toHaveLength(4); expect(verifyInstallationSet(result!)).toBe(true);
        expect(build.mock.calls.filter(([, id]) => id === shared.plugin.id)).toEqual([['mcp', shared.plugin.id, 2]]);
        expect(result?.root).toEqual(ref(root));
    });
    it('Одиночный пакет сохраняет прежний контракт без фиктивного комплекта', async () => {
        const root = skill(); const build = builderFor([]);
        expect(await resolveInstallationSet(poolFor([root]), project, root, build)).toBeUndefined();
        expect(build).not.toHaveBeenCalled();
    });
    it('Недоступная точная версия не заменяется последней', async () => {
        const pinned = remote('dependency', 1); const latest = remote('dependency', 2);
        const root = skill([pinned]); const build = vi.fn(async () => latest);
        await expect(resolveInstallationSet(poolFor([root, latest]), project, root, build)).rejects.toMatchObject({ status: 409 });
        expect(build).toHaveBeenCalledWith('mcp', pinned.plugin.id, 1);
    });
    it.each(['version', 'manifest'] as const)('Два требования одной зависимости конфликтуют по полю %s', async field => {
        const one = remote('shared', 1);
        const two = field === 'version' ? remote('shared', 2) : buildPackage(one.plugin, [], 'later', { transport: 'remote', url: 'https://changed.example.test/mcp' });
        const left = remote('left', 1, [one]); const right = remote('right', 1, [two]); const root = skill([left, right]);
        await expect(resolveInstallationSet(poolFor([root, left, right, one, two]), project, root, builderFor([left, right, one, two]))).rejects.toMatchObject({ status: 409 });
    });
    it.each(['manifest', 'kind', 'id'] as const)('Пакет зависимости не подменяется по полю %s', async field => {
        const dependency = remote('dependency'); const root = skill([dependency]);
        const wrong = field === 'manifest' ? remote('dependency', 1, [remote('extra')])
            : field === 'kind' ? buildPackage({ ...dependency.plugin, kind: 'plugin' }, [{ path: 'index.ts', content: 'export default {}' }], 'now', { entrypoint: 'index.ts' })
            : remote('other');
        await expect(resolveInstallationSet(poolFor([root, dependency, wrong]), project, root, vi.fn(async () => wrong))).rejects.toMatchObject({ status: 409 });
    });
    it('Зависимость из чужого проектного каталога не получает доступ через корневой скилл', async () => {
        const dependency = remote('dependency'); const root = skill([dependency]);
        await expect(resolveInstallationSet(poolFor([root]), project, root, builderFor([dependency]))).rejects.toMatchObject({ status: 403 });
        await expect(resolveInstallationSet(poolFor([root, dependency], 'prj-other'), project, root, builderFor([dependency]))).rejects.toMatchObject({ status: 403 });
    });
    it('Чужой проектный корень отклоняется до чтения зависимостей', async () => {
        const dependency = remote('dependency');
        const root = buildPackage({ ...skill().plugin, id: 'project-prj-other/helper' }, [{ path: 'SKILL.md', content: 'Инструкция' }], 'now');
        const build = builderFor([dependency]);
        await expect(resolveInstallationSet(poolFor([root, dependency]), project, root, build)).rejects.toMatchObject({ status: 403 });
        expect(build).not.toHaveBeenCalled();
    });
    it('Хэш комплекта и порядок пакетов не зависят от языка ОС', async () => {
        const first = remote('first'); const last = remote('last'); const root = skill([last, first]);
        const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('Локаль не должна участвовать'); });
        try {
            const result = await resolveInstallationSet(poolFor([root, first, last]), project, root, builderFor([last, first]));
            expect(verifyInstallationSet(result!)).toBe(true);
            expect(installationSetHash(ref(root), [root, first, last])).toBe(installationSetHash(ref(root), [last, first, root]));
        } finally { locale.mockRestore(); }
    });
    it('Неприкреплённые имена не преобразуются в версии автоматически', () => {
        const root = buildPackage(skill().plugin, skill().files, 'now', { extra: { requirements: { mcp: ['latest'], plugins: [] } } });
        expect(() => packageDependencies(root)).toThrow(/точные зависимости/);
    });
});

describe('Проверка сохранённого установочного комплекта', () => {
    const dependency = remote('dependency'); const root = skill([dependency]);
    it('Принимает только замкнутый состав и единственный корень', () => {
        const valid = setOf(root, [root, dependency]); expect(verifyInstallationSet(valid)).toBe(true);
        expect(verifyInstallationSet(setOf(root, [root]))).toBe(false);
        expect(verifyInstallationSet(setOf(root, [root, dependency, remote('extra')]))).toBe(false);
        expect(verifyInstallationSet(setOf(root, [root, dependency, dependency]))).toBe(false);
        expect(verifyInstallationSet(setOf(root, [dependency]))).toBe(false);
    });
    it('Изменённые файлы и неподписанный SHA не проходят проверку', () => {
        const valid = setOf(root, [root, dependency]);
        expect(verifyInstallationSet({ ...valid, manifest: 'f'.repeat(64) })).toBe(false);
        expect(verifyInstallationSet({ ...valid, packages: [{ ...root, files: [{ ...root.files[0], content: 'Подмена' }] }, dependency] })).toBe(false);
        expect(verifyInstallationSet({ ...valid, root: { ...valid.root, manifest: 'f'.repeat(64) } })).toBe(false);
    });
    it.each([null, {}, [], { schemaVersion: 2 }, { schemaVersion: 1, root: {}, packages: [] }, { schemaVersion: 1, root: {}, packages: [null] }])('Повреждённый JSONB закрывается отказом: %j', value => {
        expect(verifyInstallationSet(value as never)).toBe(false);
    });
    it.each([
        { mcp: ['name'], plugins: [] }, { mcp: 'broken' }, { dependencies: null },
        { dependencies: [{ kind: 'mcp', id: 'ai-plug-dependency', version: 'latest', manifest: 'a'.repeat(64) }] },
        { dependencies: [{ ...ref(dependency), kind: 'skill' }] },
        { dependencies: [ref(dependency), ref(dependency)] },
    ])('Не принимает неоднозначные требования в подписанных байтах: %j', requirements => {
        const bad = buildPackage(root.plugin, root.files, 'now', { extra: { requirements } });
        expect(verifyInstallationSet(setOf(bad, [bad, dependency]))).toBe(false);
    });
    it.each(['npx', 'uvx', '/usr/local/bin/server'])('Внешняя команда %s не считается закреплённым локальным MCP', command => {
        const pkg = buildPackage({ ...dependency.plugin }, [], 'now', { transport: 'stdio', command, args: ['server@latest'] });
        expect(() => assertInstallablePackage(pkg)).toThrow(); expect(verifyInstallationSet(setOf(pkg))).toBe(false);
    });
    it('Разрешает локальный Node MCP с файлом запуска из пакета и удалённый MCP', () => {
        const local = buildPackage(dependency.plugin, [{ path: 'index.mjs', content: 'console.log(1)' }], 'now', { transport: 'stdio', command: 'node', entrypoint: 'index.mjs' });
        expect(() => assertInstallablePackage(local)).not.toThrow();
        expect(() => assertInstallablePackage(dependency)).not.toThrow();
        const missing = buildPackage(dependency.plugin, [], 'now', { transport: 'stdio', command: 'node', entrypoint: 'missing.js' });
        expect(() => assertInstallablePackage(missing)).toThrow();
    });
    it.each([{ id: '' }, { id: 5 }, { version: 0 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }])('Неверная идентичность корня не становится валидной после пересчёта SHA: %j', identity => {
        const bad = buildPackage({ ...skill().plugin, ...identity } as never, skill().files, 'now');
        expect(()=>assertInstallablePackage(bad)).toThrow();
        expect(verifyInstallationSet(setOf(bad))).toBe(false);
    });
    it('Сервер и мост ограничивают ID пятьюстами символами и требуют минимум два пакета в комплекте',()=>{
        const valid=buildPackage({...skill().plugin,id:'a'.repeat(500)},skill().files,'now');
        expect(()=>assertInstallablePackage(valid)).not.toThrow();
        const long=buildPackage({...valid.plugin,id:'a'.repeat(501)},valid.files,'now');
        expect(()=>assertInstallablePackage(long)).toThrow();
        expect(verifyInstallationSet(setOf(valid))).toBe(false);
    });
});

describe('Контракт файлов серверного одобрения и локального моста',()=>{
    it('Не одобряет 101 файл, даже когда общий SHA пересчитан корректно',()=>{
        expect(()=>assertInstallablePackage(pluginPackage('files',[{path:'index.js',content:'export default {}'},...files(99)]))).not.toThrow();
        expect(()=>assertInstallablePackage(pluginPackage('files',[{path:'index.js',content:'export default {}'},...files(100)]))).toThrow(/100/);
    });
    it('Проверяет лимит 1 МиБ по байтам UTF-8, а не длине строки',()=>{
        const content='я'.repeat(524288);
        expect(()=>assertInstallablePackage(pluginPackage('bytes',[{path:'index.js',content}]))).not.toThrow();
        expect(()=>assertInstallablePackage(pluginPackage('bytes',[{path:'index.js',content:content+'я'}]))).toThrow(/1 МиБ/);
    });
    it('Отклоняет пакет больше 5 МиБ до создания одобрения',()=>{
        const packageFiles=[{path:'index.js',content:'x'.repeat(1048576)},...files(4,1048576)];
        expect(()=>assertInstallablePackage(pluginPackage('total',packageFiles))).not.toThrow();
        expect(()=>assertInstallablePackage(pluginPackage('total',[...packageFiles,{path:'overflow.txt',content:'x'}]))).toThrow(/5 МиБ/);
    });
    it.each(['../x.js','/x.js','a\\b.js','a//b.js','a/./b.js','CON.js','com0.js','LPT9.txt','a/file.','a/file ','a/\u0001.js','a/'.repeat(121)+'x.js'])('SHA не делает непереносимый путь допустимым: %s',filePath=>{
        const pkg=pluginPackage('path',[{path:filePath,content:'export default {}'}]);
        expect(()=>assertInstallablePackage(pkg)).toThrow(/путь/);
    });
    it.each([
        [{path:'index.js',content:'a'},{path:'INDEX.js',content:'b'}],
        [{path:'assets',content:'a'},{path:'assets/file.txt',content:'b'}],
        [{path:'assets/file.txt',content:'a'},{path:'assets',content:'b'}],
    ])('Не одобряет конфликт файла и каталога или регистра: %j',(first,second)=>{
        expect(()=>assertInstallablePackage(pluginPackage('collision',[first,second]))).toThrow(/конфликтуют/);
    });
    it('Скилл требует инструкцию SKILL.md и техническое имя, независимо от валидности SHA',()=>{
        const missing=buildPackage(skill().plugin,[{path:'README.md',content:'Не инструкция'}],'now');
        const invalid=buildPackage({...skill().plugin,name:'Помощник команды'},skill().files,'now');
        expect(()=>assertInstallablePackage(missing)).toThrow(/SKILL.md/);
        expect(()=>assertInstallablePackage(invalid)).toThrow(/SKILL.md/);
        expect(()=>assertInstallablePackage(skill())).not.toThrow();
    });
});

describe('Бюджет единой установки', () => {
    it('Принимает 20 инструментов и отклоняет 21 до выдачи комплекта', async () => {
        const nineteen = Array.from({ length: 19 }, (_, i) => remote(`dep-${i}`));
        const root = skill(nineteen);
        const valid = await resolveInstallationSet(poolFor([root, ...nineteen]), project, root, builderFor(nineteen));
        expect(valid?.packages).toHaveLength(20); expect(verifyInstallationSet(valid!)).toBe(true);
        const twenty = [...nineteen, remote('dep-20')]; const overflow = skill(twenty);
        await expect(resolveInstallationSet(poolFor([overflow, ...twenty]), project, overflow, builderFor(twenty))).rejects.toMatchObject({ status: 409 });
        expect(verifyInstallationSet(setOf(overflow, [overflow, ...twenty]))).toBe(false);
    });
    it('Принимает 200 файлов и отклоняет 201', async () => {
        const dependency = pluginPackage('dependency',[{path:'index.js',content:'export default {}'},...files(99)]);
        const rootFiles=[{path:'SKILL.md',content:'Инструкция'},...files(99)];
        const root = skill([dependency], rootFiles);
        const valid = await resolveInstallationSet(poolFor([root, dependency]), project, root, builderFor([dependency]));
        expect(verifyInstallationSet(valid!)).toBe(true);
        const extra=pluginPackage('extra',[{path:'index.js',content:'x'}]);
        const overflow = skill([dependency,extra],rootFiles);
        await expect(resolveInstallationSet(poolFor([overflow,dependency,extra]), project, overflow, builderFor([dependency,extra]))).rejects.toMatchObject({ status: 409 });
        expect(verifyInstallationSet(setOf(overflow, [overflow,dependency,extra]))).toBe(false);
    });
    it('Считает размер по байтам файлов; 16 МиБ принимаются, лишний байт останавливает набор', async () => {
        const dependencies=Array.from({length:3},(_,i)=>pluginPackage(`dependency-${i}`,[{path:'index.js',content:'x'.repeat(1048576)},...files(3,1048576)]));
        const rootFiles = [{path:'SKILL.md',content:'x'.repeat(1048576)},...files(3,1048576)];
        const root = skill(dependencies, rootFiles);
        const valid = await resolveInstallationSet(poolFor([root,...dependencies]), project, root, builderFor(dependencies));
        expect(verifyInstallationSet(valid!)).toBe(true);
        const overflow = skill(dependencies, [...rootFiles, { path: 'assets/overflow.txt', content: 'x' }]);
        await expect(resolveInstallationSet(poolFor([overflow,...dependencies]), project, overflow, builderFor(dependencies))).rejects.toMatchObject({ status: 409 });
        expect(verifyInstallationSet(setOf(overflow, [overflow,...dependencies]))).toBe(false);
    });
});
