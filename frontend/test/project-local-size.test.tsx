import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import type {IBridgeDevice} from '../src/features/McpBridge/api';
import type {IBridgeBinding} from '../src/features/McpBridge/operationTypes';
import {projectDataSize} from '../src/modules/Projects/features/ProjectSize/localProjectDataSize';
import {ProjectFolderDataSize} from '../src/modules/Projects/features/ProjectSize/ProjectFolderDataSize';

const now=Date.parse('2026-10-26T02:00:00.000Z');
const binding:IBridgeBinding={projectId:'prj-a',folderName:'bank',valid:true,identityStatus:'verified',bindingId:'a'.repeat(64),instanceId:'12345678-1234-1234-1234-123456789abc',
    dataSize:{scope:'opencode',bytes:2048,measuredAt:new Date(now).toISOString()}};
const device:IBridgeDevice={id:'computer-a',name:'Рабочий компьютер',role:'Разработчик',fingerprint:'',lastSeen:new Date(now).toISOString(),online:true,
    report:{capabilities:['project-data-size-v1'],bindings:[binding]}};
const input={projectId:'prj-a',serverBytes:null,serverError:'Старый серверный путь недоступен.',device,devicesReady:true,canRead:true,canBind:true,now};
const withBinding=(change:Partial<IBridgeBinding>):IBridgeDevice=>({...device,report:{...device.report,bindings:[{...binding,...change}]}});
const withSize=(change:Partial<NonNullable<IBridgeBinding['dataSize']>>):IBridgeDevice=>withBinding({dataSize:{...binding.dataSize!,...change}});

describe('Размер данных выбранного компьютера',()=>{
    it('Берёт измерение подтверждённой папки вместо отсутствующего серверного пути',()=>{
        expect(projectDataSize(input)).toMatchObject({bytes:2048,source:'local',sourceLabel:'На «Рабочий компьютер»'});
        expect(projectDataSize({...input,serverBytes:9000})).toMatchObject({bytes:2048,source:'local'});
    });
    it('Принимает настоящий пустой локальный каталог и не смешивает его с серверным числом',()=>{
        expect(projectDataSize({...input,serverBytes:9000,device:withSize({bytes:0})})).toMatchObject({bytes:0,source:'local'});
    });
    it('Остаётся на выбранном компьютере, а не заимствует чужую подходящую папку',()=>{
        const other={...device,id:'computer-b',report:{...device.report,bindings:[{...binding,projectId:'prj-b'}]}};
        expect(projectDataSize({...input,device:other})).toMatchObject({bytes:null,label:'Папка не связана',action:{href:'/start?setup=1&p=prj-a'}});
        expect(projectDataSize({...input,device:undefined})).toMatchObject({bytes:null,label:'Выберите компьютер'});
    });
    it('Измеренный серверный каталог остаётся доступен для серверного проекта без локальной привязки',()=>{
        expect(projectDataSize({...input,device:withBinding({projectId:'prj-other'}),serverBytes:0})).toMatchObject({bytes:0,source:'server',sourceLabel:'На сервере'});
        expect(projectDataSize({...input,device:undefined,serverBytes:2048})).toMatchObject({bytes:2048,source:'server'});
    });
    it.each([
        {device:{...device,online:false}},
        {device:{...device,online:false,report:{...device.report,bindings:[]}}},
        {device:{...device,requiresReconnect:true}},
    ])('Не показывает локальные байты отключённого или устаревшего снимка: %j',change=>{
        expect(projectDataSize({...input,serverBytes:9999,...change})).toMatchObject({bytes:null,label:'Компьютер недоступен'});
    });
    it.each([0,2048])('Не подменяет ещё не прочитанную локальную привязку серверным значением %s',serverBytes=>{
        expect(projectDataSize({...input,device:undefined,devicesReady:false,serverBytes})).toMatchObject({bytes:null,label:'Данные не подтверждены'});
        expect(projectDataSize({...input,device:undefined,devicesReady:false,loading:true,serverBytes})).toMatchObject({bytes:null,label:'Проверяем размер…'});
    });
    it('Не выбирает серверный fallback вместо ещё не выбранного компьютера',()=>{
        expect(projectDataSize({...input,device:undefined,devices:[device,{...device,id:'computer-b'}],serverBytes:2048})).toMatchObject({bytes:null,label:'Выберите компьютер'});
    });
    it.each([
        {valid:false}, {valid:undefined}, {identityStatus:'legacy' as const}, {identityStatus:'copied' as const},
        {bindingId:undefined},{bindingId:'old-hash'},{instanceId:undefined},{instanceId:'wrong-instance'},
    ])('Не принимает неподтверждённую привязку: %j',change=>{
        expect(projectDataSize({...input,device:withBinding(change)})).toMatchObject({bytes:null,label:'Проверьте привязку'});
    });
    it('Не выбирает одну из двух конфликтующих привязок одного проекта',()=>{
        const duplicate={...device,report:{...device.report,bindings:[binding,{...binding,instanceId:'87654321-4321-4321-4321-cba987654321'}]}};
        expect(projectDataSize({...input,device:duplicate})).toMatchObject({bytes:null,label:'Проверьте привязку'});
    });
    it('Отличает старый мост от ещё не завершённого первого измерения',()=>{
        expect(projectDataSize({...input,device:{...device,report:{...device.report,capabilities:[]}}})).toMatchObject({bytes:null,label:'Обновите мост'});
        expect(projectDataSize({...input,device:withBinding({dataSize:undefined})})).toMatchObject({bytes:null,label:'Измеряем…'});
    });
    it.each([
        {bytes:-1},{bytes:NaN},{bytes:Infinity},{bytes:'2048' as unknown as number},{bytes:null},
        {scope:'project' as 'opencode'}, {bytes:2048,error:'unavailable' as const},
        {measuredAt:'not-a-date'}, {measuredAt:'2026-10-26T02:00:00Z'},
        {measuredAt:new Date(now+5001).toISOString()},
    ])('Не принимает некорректное измерение: %j',change=>{
        expect(projectDataSize({...input,device:withSize(change)})).toMatchObject({bytes:null,label:'Замер недоступен'});
    });
    it('Ограничивает срок измерения и допускает небольшой сдвиг часов',()=>{
        expect(projectDataSize({...input,now:now+60000})).toMatchObject({bytes:2048});
        expect(projectDataSize({...input,now:now+60001})).toMatchObject({bytes:null,label:'Замер устарел'});
        expect(projectDataSize({...input,device:withSize({measuredAt:new Date(now+5000).toISOString()})})).toMatchObject({bytes:2048});
    });
    it.each(['unavailable','limit-exceeded'] as const)('Ошибка %s не выдаёт частичную сумму за размер',error=>{
        expect(projectDataSize({...input,device:withSize({bytes:null,error})})).toMatchObject({bytes:null,label:'Размер не измерен'});
    });
    it('Отзыв права чтения немедленно скрывает локальное и серверное число',()=>{
        const denied=projectDataSize({...input,canRead:false,serverBytes:9000});
        expect(denied).toMatchObject({bytes:null,label:'Нет доступа'});expect(denied.action).toBeUndefined();
    });
    it('Наблюдатель читает размер, но не получает действие новой привязки',()=>{
        expect(projectDataSize({...input,canBind:false})).toMatchObject({bytes:2048});
        const unbound=projectDataSize({...input,canBind:false,device:withBinding({projectId:'prj-b'})});
        expect(unbound.label).toBe('Папка не связана');expect(unbound.action).toBeUndefined();
    });
});

describe('Действия и объяснение локального размера',()=>{
    function render(current:IBridgeDevice,canBind=true,showSetupAction=true){
        const measuredAt=new Date().toISOString();
        const actual={...current,report:{...current.report,bindings:current.report.bindings?.map(item=>({...item,dataSize:item.dataSize?{...item.dataSize,measuredAt}:undefined}))}};
        return renderToStaticMarkup(createElement(ProjectFolderDataSize,{project:{id:'prj-a',logicalBytes:null,logicalSizeError:'Старый путь'},
            bridge:{device:actual,devices:[actual],devicesReady:true,loading:false},canRead:true,canBind,showSetupAction,title:'Данные проекта',loading:false,onRetry:vi.fn()}));
    }
    it('Показывает фактический размер с понятным источником и без старой серверной ошибки',()=>{
        const html=render(device);expect(html).toContain('2 КБ');expect(html).toContain('Рабочий компьютер');expect(html).toContain('папке «bank»');
        expect(html).not.toContain('Старый путь');expect(html).not.toContain('Повторить');
    });
    it('Несвязанная папка имеет точный переход и read-only повтор, который не запускает установку',()=>{
        const html=render(withBinding({projectId:'prj-other'}));
        expect(html).toContain('Папка не связана');expect(html).toContain('href="/start?setup=1&amp;p=prj-a"');
        expect(html).toContain('Повторить измерение данных проекта');
    });
    it('Старая версия моста имеет переход на подключение компьютера',()=>{
        const html=render({...device,report:{...device.report,capabilities:[]}});
        expect(html).toContain('Обновите мост');expect(html).toContain('href="/start?setup=1&amp;p=prj-a"');
    });
    it('В списке скрывает только повторный setup action, сохраняя причину и read-only retry',()=>{
        const html=render(withBinding({projectId:'prj-other'}),true,false);
        expect(html).toContain('Папка не связана');expect(html).toContain('Почему неизвестен размер данных проекта');expect(html).toContain('Повторить измерение данных проекта');
        expect(html).not.toContain('href="/start?setup=1');
    });
    it('До чтения текущих компьютеров не показывает серверный ноль как размер проекта',()=>{
        const html=renderToStaticMarkup(createElement(ProjectFolderDataSize,{project:{id:'prj-a',logicalBytes:0},
            bridge:{device:undefined,devices:[],devicesReady:false,loading:true},canRead:true,canBind:true,title:'Данные проекта',loading:false,onRetry:vi.fn()}));
        expect(html).toContain('Проверяем размер…');expect(html).not.toContain('0 Б');expect(html).not.toContain('На сервере');
    });
});
