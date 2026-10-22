import {describe,expect,it} from 'vitest';
import {checkPublicationMcpField,publicationPayload} from '../src/features/Catalog/publication/publicationDraft';
import type {IAiPluginCreate,ISkillCreateRequest} from '../src/core/api/interfaces';
const common={name:'Помощник',description:'Проверка кода',tags:'код, код, команда'};
describe('Форма добавления в общий магазин',()=>{
    it('Не публикует тупиковую локальную команду без закреплённого пакета',()=>{
        expect(()=>publicationPayload({...common,kind:'mcp',mode:'command',command:'npx',args:'["-y","@example/mcp"]'},[])).toThrow('Упаковать инструмент');
    });
    it('Не делит аргументы по пробелам и запятым',()=>{const result=publicationPayload({...common,kind:'mcp',mode:'bundle',entrypoint:'index.js',args:'["Мои проекты/file.js", "a,b"]'},[{path:'index.js',content:'export {};'}]) as IAiPluginCreate;expect(result.config?.args).toEqual(['Мои проекты/file.js','a,b']);});
    it('Смена типа не отправляет скрытый конфиг другого инструмента',()=>{const result=publicationPayload({...common,kind:'skill',slug:'my-helper',instruction:'Полная инструкция',url:'https://example.org'},[]) as ISkillCreateRequest;expect(result).not.toHaveProperty('config');expect(result.name).toBe('Помощник');expect(result.meta?.tags).toEqual(['код','команда']);});
    it('Не отбрасывает незаполненный файл молча',()=>{expect(()=>publicationPayload({...common,kind:'plugin',entrypoint:'index.js'},[{path:'index.js',content:'code'},{path:'',content:'lost'}])).toThrow(/каждого файла/);});
    it('Сообщает ошибку JSON и неподходящий тип аргументов',()=>{const files=[{path:'index.js',content:'export {};'}];expect(()=>publicationPayload({...common,kind:'mcp',mode:'bundle',entrypoint:'index.js',args:'bad'},files)).toThrow(/JSON/);expect(()=>publicationPayload({...common,kind:'mcp',mode:'bundle',entrypoint:'index.js',args:'{"a":1}'},files)).toThrow(/массив/);});
    it('Удалённый MCP сохраняет заголовки и выбор OAuth без локальных файлов',()=>{const result=publicationPayload({...common,kind:'mcp',mode:'remote',url:'https://example.org/mcp',headers:'{"Authorization":"Bearer {env:TOKEN}"}',disableOAuth:true},[{path:'index.js',content:'старый пакет'}]) as IAiPluginCreate;expect(result.files).toBeUndefined();expect(result.config?.oauth).toBe(false);expect(result.config?.headers?.Authorization).toBe('Bearer {env:TOKEN}');});
    it('Публикация отклоняет ключ с literal префиксом рядом со ссылкой',()=>{expect(()=>publicationPayload({...common,kind:'mcp',mode:'remote',url:'https://example.org/mcp',headers:'{"Authorization":"Bearer secret {env:TOKEN}"}'},[])).toThrow('замените секрет');});
    it('Проверяет каждое поле MCP независимо от незаполненных соседних полей',()=>{
        expect(()=>checkPublicationMcpField('url','ftp://example.org/mcp')).toThrow('HTTP(S)');
        expect(()=>checkPublicationMcpField('headers','not-json')).toThrow('Заголовки: проверьте JSON');
        expect(()=>checkPublicationMcpField('command','  ')).toThrow('программу');
        expect(()=>checkPublicationMcpField('args','[1]')).toThrow('массивом строк');
        expect(()=>checkPublicationMcpField('env','{"API_KEY":"secret"}')).toThrow('замените секрет');
        expect(()=>checkPublicationMcpField('env','{"MODE":42}')).toThrow('строковыми значениями');
    });
    it('Полевые проверки сохраняют ссылки на секреты и пробелы в аргументах',()=>{
        expect(()=>checkPublicationMcpField('headers','{"Authorization":"Bearer {env:MCP_TOKEN}"}')).not.toThrow();
        expect(()=>checkPublicationMcpField('env','{"API_KEY":"{env:API_KEY}"}')).not.toThrow();
        expect(()=>checkPublicationMcpField('args','["Мои проекты/index.js", "--label", "Два слова"]')).not.toThrow();
        expect(()=>checkPublicationMcpField('args','')).not.toThrow();
        expect(()=>checkPublicationMcpField('env',undefined)).not.toThrow();
    });
});
