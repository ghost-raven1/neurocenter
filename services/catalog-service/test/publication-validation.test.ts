import { describe, expect, it } from 'vitest';
import { filePath, packageFiles, publicationHash, validatePublication } from '../src/publication/publication-validation';

const remote = () => ({name:'Помощник команды',kind:'mcp',description:'Ищет документы',config:{transport:'remote',url:'https://example.org/mcp'}});
const local = () => ({...remote(),config:{transport:'stdio',command:'node',entrypoint:'server.js',args:['C:\\Мои проекты\\server.js','--label','Текст с пробелами']},files:[{path:'server.js',content:'export default {}'}]});
const plugin = () => ({name:'Проверка кода',kind:'plugin',description:'Подсказывает ошибки',config:{entrypoint:'index.ts'},files:[{path:'index.ts',content:'export const helper = () => ({})'}]});

describe('Публикация в общий магазин', () => {
    it('Принимает русское название независимо от пути запуска', () => { expect(validatePublication(remote()).name).toBe('Помощник команды'); });
    it('Не допускает название из пространства ID инструмента', () => { expect(()=>validatePublication({...remote(),name:'ai-plug-other'})).toThrow(/зарезервирован/); });
    it('Сохраняет аргументы с пробелами, запятыми и путями Windows без разбиения', () => { const body=local(); expect(validatePublication(body).config?.args).toEqual(body.config.args); });
    it.each([null,[],{}, {name:'x',kind:'other',description:'x'}, {...remote(),name:'   '}, {...remote(),description:''}, {...remote(),version:2}, {...remote(),unknown:true}, {...remote(),tags:'tag'}])('Отклоняет неполные и неподдерживаемые данные: %j', body => { expect(()=>validatePublication(body)).toThrow(); });
    it.each(['file:///etc/passwd','javascript:alert(1)','https://user:password@example.org/mcp','https://example.org/mcp?token=abc','https://example.org/mcp#fragment','wrong'])('Отклоняет неподходящий URL: %s', url => { expect(()=>validatePublication({...remote(),config:{transport:'remote',url}})).toThrow(); });
    it('Не сохраняет личный ключ в общем каталоге', () => { expect(()=>validatePublication({...local(),config:{transport:'stdio',command:'node',env:{API_KEY:'private'}}})).toThrow(/env:/); });
    it('Принимает ссылки на личное окружение и обычные параметры', () => { expect(validatePublication({...remote(),config:{...remote().config,headers:{Authorization:'Bearer {env:MCP_TOKEN}'},oauth:false}}).config?.headers?.Authorization).toBe('Bearer {env:MCP_TOKEN}'); });
    it.each(['private-{env:TOKEN}', '{env:TOKEN}-private', '{env:ONE}{env:TWO}', 'Bearer {env:TOKEN}', ' {env:TOKEN}', '{env:TOKEN} '])('Не разрешает прятать секрет окружения рядом со ссылкой: %s', value => {
        expect(() => validatePublication({...local(), config:{transport:'stdio',command:'node',env:{API_TOKEN:value}}})).toThrow(/env:/);
    });
    it.each(['Bearer private {env:TOKEN}', 'Basic {env:TOKEN} private', 'Token {env:TOKEN}', 'Bearer  {env:TOKEN}', '{env:TOKEN}{env:OTHER}'])('Отклоняет произвольный шаблон авторизации: %s', value => {
        expect(() => validatePublication({...remote(), config:{...remote().config,headers:{Authorization:value}}})).toThrow(/env:/);
    });
    it.each(['{env:TOKEN}', 'Bearer {env:TOKEN}', 'Basic {env:TOKEN}', 'bearer {env:TOKEN}'])('Принимает только разрешённые шаблоны авторизации: %s', value => {
        expect(validatePublication({...remote(), config:{...remote().config,headers:{authorization:value}}}).config?.headers?.authorization).toBe(value);
    });
    it('Заголовок с ключом принимает только полную ссылку, обычные заголовки сохраняет', () => {
        expect(() => validatePublication({...remote(),config:{...remote().config,headers:{'X-API-Key':'private{env:TOKEN}'}}})).toThrow(/env:/);
        expect(validatePublication({...remote(),config:{...remote().config,headers:{'X-API-Key':'{env:TOKEN}',Accept:'application/json'}}}).config?.headers).toEqual({'X-API-Key':'{env:TOKEN}',Accept:'application/json'});
        expect(validatePublication({...local(),config:{...local().config,env:{API_TOKEN:'{env:TOKEN}',PORT:'3000'}}}).config?.env).toEqual({API_TOKEN:'{env:TOKEN}',PORT:'3000'});
    });
    it.each([[],{PORT:3000}, JSON.parse('{"__proto__":"value"}'), {PORT:'a\nb'}])('Проверяет строковое окружение: %j', env => { expect(()=>validatePublication({...local(),config:{transport:'stdio',command:'node',env}})).toThrow(); });
    it('Отклоняет объект OAuth, который публикация пока не поддерживает', () => { expect(()=>validatePublication({...remote(),config:{...remote().config,oauth:{clientSecret:'private'}}})).toThrow(); });
    it('Не теряет локальные файлы при выборе удалённого MCP', () => { expect(()=>validatePublication({...remote(),files:[{path:'index.js',content:'code'}]})).toThrow(); });
    it('Требует существующий файл запуска локального пакета', () => { expect(()=>validatePublication({...local(),files:[{path:'readme.md',content:'Инструкция'}]})).toThrow(); });
    it('Принимает подготовленный текстовый пакет с явным файлом запуска', () => { expect(validatePublication({...local(),config:{transport:'stdio',command:'node',entrypoint:'dist/index.mjs'},files:[{path:'dist/index.mjs',content:'console.log(1)'}]}).config?.entrypoint).toBe('dist/index.mjs'); });
    it('Не выдаёт пакет из одного README за плагин', () => { expect(()=>validatePublication({...plugin(),config:{entrypoint:'README.md'},files:[{path:'README.md',content:'Текст'}]})).toThrow(); });
    it('Считает размер русского текста в байтах и игнорирует поддельный digest', () => { const file=packageFiles([{path:'notes.md',content:'Привет',size:1,digest:'fake'}])[0]; expect(file.size).toBe(12); expect(file.digest).toHaveLength(64); });
    it.each(['../x.js','/x.js','C:/x.js','a\\b.js','a//b.js','a/./b.js','CON.js','a/NUL.txt','a/file.','.env.production','.git/config','node_modules/a.js'])('Отклоняет непереносимый путь: %s', value => { expect(()=>filePath(value)).toThrow(); });
    it.each([[{path:'index.js',content:'a'},{path:'INDEX.js',content:'b'}],[{path:'dist',content:'a'},{path:'dist/index.js',content:'b'}]])('Отклоняет конфликтующие пути до записи: %j', files => { expect(()=>packageFiles(files)).toThrow(); });
    it('Сохраняет NFD-путь для импортов и не создаёт эквивалентные Unicode-файлы', () => {
        const decomposed = 'cafe\u0301.ts';
        expect(filePath(decomposed)).toBe(decomposed);
        expect(packageFiles([{path: decomposed, content: 'fixture'}])[0].path).toBe(decomposed);
        expect(() => packageFiles([{path: decomposed, content: 'one'}, {path: 'café.ts', content: 'two'}])).toThrow('конфликтуют');
        expect(() => packageFiles([{path: 'café', content: 'one'}, {path: 'cafe\u0301/child.ts', content: 'two'}])).toThrow('конфликтуют');
    });
    it.each(['.yarnrc', '.yarnrc.yml', 'nested/.YARNRC.YML'])('Не принимает настройки registry с личными токенами: %s', path => {
        expect(() => packageFiles([{path, content: 'npmAuthToken: fixture-token'}])).toThrow('Недопустимый путь');
    });
    it('Нестроковый JSON-путь возвращает объяснимый отказ без вызова методов входного объекта', () => {
        for (const value of [null, 42, {toString: false}]) {
            expect(() => filePath(value)).toThrow('Путь файла: ожидается текст.');
        }
    });
    it('Не публикует декларацию типов как исполняемый плагин', () => {
        expect(() => validatePublication({...plugin(), config: {entrypoint: 'index.d.ts'}, files: [{path: 'index.d.ts', content: 'export declare const fixture: string;'}]})).toThrow('без деклараций');
    });
    it('Не принимает бинарное содержимое и файл сверх лимита', () => { expect(()=>packageFiles([{path:'x.js',content:'a\0b'}])).toThrow(); expect(()=>packageFiles([{path:'x.js',content:'я'.repeat(524289)}])).toThrow(); });
    it('Хэш повторного запроса не зависит от порядка ключей JSON', () => { expect(publicationHash({a:1,b:{z:2,x:3}})).toBe(publicationHash({b:{x:3,z:2},a:1})); });
    it('Закрепляет зависимости по ID, версии и SHA, сохраняя одинаковый порядок повторного запроса', () => {
        const one={kind:'mcp',id:'ai-plug-example',version:2,manifest:'a'.repeat(64)};
        const two={...one,kind:'plugin',id:'ai-plug-other'};
        const a=validatePublication({...remote(),dependencies:[two,one]});
        const b=validatePublication({...remote(),dependencies:[one,two]});
        expect(a.dependencies).toEqual([one,two]);expect(publicationHash(a)).toBe(publicationHash(b));
        expect(validatePublication({...remote(),dependencies:[]}).dependencies).toBeUndefined();
    });
    it.each([null,'head',[{kind:'skill',id:'ai-plug-one',version:1,manifest:'a'.repeat(64)}],
        [{kind:'mcp',id:'helper',version:1,manifest:'a'.repeat(64)}],
        [{kind:'mcp',id:'ai-plug-one',version:1,manifest:'a'.repeat(64),head:true}],
        [{kind:'mcp',id:'ai-plug-one',version:1,manifest:'wrong'}]])('Некорректные pins не попадают в каталог: %j',dependencies=>{
        expect(()=>validatePublication({...remote(),dependencies})).toThrow();
    });
});

const runtimeArtifact = (extra:Record<string,unknown>={}) => ({target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'runtime/server.mjs',...extra});
const localConfiguration = () => ({schemaVersion:1,fields:[{id:'token',label:'Ключ пользователя',type:'string',required:true,secret:true,target:{kind:'env',name:'MCP_TOKEN'}}]});

describe('Публичная публикация готовых комплектов и локальных настроек 0.9',()=>{
    it('Публикует artifact-only MCP без внешней команды и встроенных файлов',()=>{
        const result=validatePublication({...remote(),config:{transport:'stdio',extra:{runtimeArtifacts:[runtimeArtifact()],localConfiguration:localConfiguration()}}});
        expect(result.files).toEqual([]);expect(result.config?.command).toBeUndefined();expect(result.config?.entrypoint).toBeUndefined();expect(result.config?.extra).toEqual({runtimeArtifacts:[runtimeArtifact()],localConfiguration:localConfiguration()});
    });
    it('Принимает старые явные поля node и entrypoint только при совпадении с готовым комплектом',()=>{
        const result=validatePublication({...remote(),config:{transport:'stdio',command:'node',entrypoint:'runtime/server.mjs',args:['--label','Русское имя'],extra:{runtimeArtifacts:[runtimeArtifact()]}}});expect(result.config?.command).toBe('node');expect(result.config?.entrypoint).toBe('runtime/server.mjs');expect(result.config?.args).toEqual(['--label','Русское имя']);
    });
    it('Публикует нативный MCP с запуском только из одобренного descriptor',()=>{
        const artifact=runtimeArtifact({entrypoint:'runtime/server',executable:true});expect(validatePublication({...remote(),config:{transport:'stdio',extra:{runtimeArtifacts:[artifact]}}}).config?.extra?.runtimeArtifacts).toEqual([artifact]);
    });
    it('Сохраняет локальную схему для обычного встроенного Node-пакета',()=>{
        const result=validatePublication({...remote(),config:{transport:'stdio',command:'node',entrypoint:'server.js',extra:{localConfiguration:localConfiguration()}},files:[{path:'server.js',content:'export default {};'}]});expect(result.config?.extra?.localConfiguration).toEqual(localConfiguration());
    });
    it('Удалённый MCP принимает декларацию закрытого заголовка без самого ключа',()=>{
        const schema={schemaVersion:1,fields:[{id:'key',label:'Ключ доступа',type:'string',required:true,secret:true,target:{kind:'header',name:'Authorization',prefix:'Bearer '}}]};const result=validatePublication({...remote(),config:{...remote().config,extra:{localConfiguration:schema}}});expect(result.config?.extra?.localConfiguration).toEqual(schema);
    });
    it.each([{command:'curl'}, {command:'npm'}, {entrypoint:'другой.mjs'}, {command:'node',extra:{runtimeArtifacts:[runtimeArtifact({executable:true})]}}])('Не игнорирует противоречащие поля готового MCP: %j',source=>{
        expect(()=>validatePublication({...remote(),config:{transport:'stdio',extra:{runtimeArtifacts:[runtimeArtifact()]},...source}})).toThrow(/команд|descriptor/);
    });
    it.each([{entrypoint:'runtime/plugin.mjs'}, {entrypoint:'runtime/plugin.js'}, {entrypoint:'runtime/plugin.cjs'}])('Публикует JS-плагин без встроенных файлов: $entrypoint',artifact=>{
        const result=validatePublication({...plugin(),config:{extra:{runtimeArtifacts:[runtimeArtifact(artifact)]}},files:[]});expect(result.config?.entrypoint).toBeUndefined();expect(result.config?.extra?.runtimeArtifacts).toEqual([runtimeArtifact(artifact)]);
    });
    it.each([{entrypoint:'runtime/plugin.exe',executable:true},{entrypoint:'runtime/plugin.mjs',executable:true},{entrypoint:'runtime/plugin.py'}])('Не публикует нативный или не-JS плагин: $entrypoint',artifact=>{expect(()=>validatePublication({...plugin(),config:{extra:{runtimeArtifacts:[runtimeArtifact(artifact)]}},files:[]})).toThrow(/плагину.*\.js/);});
    it('Плагин не получает схему настройки до реализации его адаптера',()=>{expect(()=>validatePublication({...plugin(),config:{entrypoint:'index.ts',extra:{localConfiguration:localConfiguration()}}})).toThrow(/схема/);});
    it.each([{install:'npm install package'}, {requirements:{dependencies:[]}}, {secrets:{token:'ЛИЧНЫЙ_КЛЮЧ'}}, {runtimeArtifacts:[{...runtimeArtifact(),url:'https://example.org/install.sh'}]}])('Не расширяет extra произвольными параметрами или URL: %j',extra=>{expect(()=>validatePublication({...remote(),config:{transport:'stdio',extra}})).toThrow();});
    it('Удалённый MCP не публикует неиспользуемый локальный архив',()=>{expect(()=>validatePublication({...remote(),config:{...remote().config,extra:{runtimeArtifacts:[runtimeArtifact()]}}})).toThrow(/Удалённому/);});
    it.each([{...localConfiguration(),fields:[{...localConfiguration().fields[0],value:'СЕКРЕТ'}]}, {...localConfiguration(),fields:[{...localConfiguration().fields[0],target:{kind:'env',name:'NODE_OPTIONS'}}]}])('Схема с готовыми значениями или опасным окружением отвергается публичным API',schema=>{expect(()=>validatePublication({...remote(),config:{transport:'stdio',command:'node',extra:{localConfiguration:schema}}})).toThrow(/поле/);});
    it('Точные зависимости сохраняются отдельно от extra готового комплекта',()=>{
        const dependency={kind:'mcp',id:'ai-plug-dependency',version:1,manifest:'b'.repeat(64)};const result=validatePublication({...remote(),dependencies:[dependency],config:{transport:'stdio',extra:{runtimeArtifacts:[runtimeArtifact()]}}});expect(result.dependencies).toEqual([dependency]);expect(result.config?.extra?.requirements).toBeUndefined();
    });
});
