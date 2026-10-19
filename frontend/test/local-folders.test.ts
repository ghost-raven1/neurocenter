import {describe,expect,it,vi} from 'vitest';
import {bindDirectory,childDirectories,isPickerCancelled} from '../src/modules/Projects/local/localFolders';
import type {ILocalDirectory,ILocalFile} from '../src/modules/Projects/local/localFolders';

function directory(name:string,files=new Map<string,string>()):ILocalDirectory & {files:Map<string,string>} {
    const result:ILocalDirectory & {files:Map<string,string>}={kind:'directory',name,files,
        async *values(){yield directory('Проект Б');yield directory('.git');yield directory('Проект А');},
        queryPermission:vi.fn(async()=>'granted' as const),requestPermission:vi.fn(async()=>'granted' as const),
        async getDirectoryHandle(key,options){if(key==='.opencode'&&(options?.create||files.has('neurocenter.json'))){return result;}throw new DOMException('нет папки','NotFoundError');},
        async getFileHandle(key,options){if(!files.has(key)&&!options?.create){throw new DOMException('нет файла','NotFoundError');}
            let pending='';
            return {kind:'file',name:key,async getFile(){return {text:async()=>files.get(key) ?? ''} as File;},async createWritable(){return {write:async(text:string)=>{pending=text;},close:async()=>{files.set(key,pending);},abort:async()=>undefined};}} as ILocalFile;
        },
    };return result;
}
describe('Локальные папки проектов',()=>{
    it('Связывает другую локальную папку с постоянным серверным ID',async()=>{const root=directory('Папка с другим именем');const result=await bindDirectory(root,'prj-team','http://localhost:5173');expect(result.projectId).toBe('prj-team');expect(JSON.parse(root.files.get('neurocenter.json')!)).toEqual({version:1,server:'http://localhost:5173',projectId:'prj-team'});});
    it('Повторная привязка того же проекта сохраняет дополнительные поля файла',async()=>{const original=JSON.stringify({version:1,server:'https://example.org',projectId:'prj-team',custom:true});const root=directory('local',new Map([['neurocenter.json',original]]));await bindDirectory(root,'prj-team','https://example.org');expect(root.files.get('neurocenter.json')).toBe(original);});
    it.each([JSON.stringify({version:1,server:'https://another.example.org',projectId:'prj-team'}),JSON.stringify({version:1,server:'https://example.org',projectId:'prj-other'}),'{bad'])('Не заменяет чужую или повреждённую привязку: %s',async original=>{const root=directory('local',new Map([['neurocenter.json',original]]));await expect(bindDirectory(root,'prj-team','https://example.org')).rejects.toThrow();expect(root.files.get('neurocenter.json')).toBe(original);});
    it('Отказ в разрешении не создаёт файлы проекта',async()=>{const root=directory('local');vi.mocked(root.queryPermission).mockResolvedValue('denied');vi.mocked(root.requestPermission).mockResolvedValue('denied');await expect(bindDirectory(root,'prj-team','https://example.org')).rejects.toThrow(/разрешения/);expect(root.files.size).toBe(0);});
    it('Читает только список видимых папок без загрузки их содержимого',async()=>{expect((await childDirectories(directory('projects'))).map(item=>item.name)).toEqual(['Проект А','Проект Б']);});
    it('Отмена выбора не считается ошибкой сохранения',()=>{expect(isPickerCancelled(new DOMException('отмена','AbortError'))).toBe(true);expect(isPickerCancelled(new Error('ошибка'))).toBe(false);});
});
