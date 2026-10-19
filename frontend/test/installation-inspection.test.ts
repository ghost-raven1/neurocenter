import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice, IBridgeInstallation, IBridgeJob, IInstallationInspection } from '../src/features/McpBridge/api';
import type { useBridge } from '../src/features/McpBridge/useBridge';
import { InstallationInspectionStatus, matchingInspection } from '../src/features/McpBridge/InstallationInspectionStatus';
import { LocalInstallations } from '../src/features/McpBridge/LocalInstallations';
import { hasCurrentBinding, installationIdentity, installationRequest, latestAssetJob, latestInspectionJob, removalSelection, currentInstallation } from '../src/features/McpBridge/installationHelpers';
import { inspectionBlocker, installationBlocker } from '../src/features/McpBridge/readiness';

const bindingA = 'a'.repeat(64);
const bindingB = 'b'.repeat(64);
const device: IBridgeDevice = {id:'device',name:'Мой компьютер',role:'Наблюдатель',fingerprint:'',online:true,lastSeen:null,report:{
    protocolVersion:2,capabilities:['durable-completions','managed-installations','install-set-v1','installation-inspection-v1'],
    bindings:[{projectId:'project',folderName:'Папка Б',valid:true,bindingId:bindingB}],
}};
const row: IBridgeInstallation = {deviceId:device.id,projectId:'project',assetId:'ai-plug-helper',assetKind:'mcp',name:'Помощник',
    version:2,manifest:'c'.repeat(64),updatedAt:'2026-10-17T10:00:00Z',bindingId:bindingB,isCurrentBinding:true,folderName:'Папка Б'};
const inspection: IInstallationInspection = {schemaVersion:1,projectId:row.projectId,bindingId:bindingB,assetId:row.assetId,assetKind:row.assetKind,
    version:row.version,manifest:row.manifest,checkedAt:'2026-10-17T11:00:00Z',readiness:'unverified',state:'checked',status:'synced',issues:[]};
const job: IBridgeJob = {id:'job',deviceId:device.id,projectId:row.projectId,assetId:row.assetId,assetKind:row.assetKind,bindingId:bindingB,
    kind:'inspect-installation',state:'running',message:'Сверяем файлы',createdAt:row.updatedAt,updatedAt:row.updatedAt};
function bridge(items: IBridgeInstallation[] = [row], jobs: IBridgeJob[] = [], target: IBridgeDevice = device): ReturnType<typeof useBridge> {
    return {device:target,devices:[target],devicesReady:true,jobsReady:true,installationsReady:true,jobs,installations:items,
        errors:{devices:'',jobs:'',installations:''},error:'',loading:false,reload:vi.fn(async()=>undefined),choose:vi.fn()};
}
function buttons(html: string, text: string): string[] {
    return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(item=>item[2].includes(text)).map(item=>item[1]);
}
function render(items: IBridgeInstallation[] = [row], jobs: IBridgeJob[] = [], target: IBridgeDevice = device, canManage = false, canInspect = true): string {
    return renderToStaticMarkup(createElement(LocalInstallations,{bridge:bridge(items,jobs,target),projectId:row.projectId,canManage,canInspect,catalog:[],approved:new Set<string>()}));
}

describe('Идентичность установки в разных папках',()=>{
    it('Три привязки одного инструмента получают разные стабильные ключи',()=>{
        const items=[row,{...row,bindingId:bindingA,isCurrentBinding:false},{...row,bindingId:null,legacyBinding:true}];
        expect(new Set(items.map(installationIdentity)).size).toBe(3);
        expect(installationIdentity({...row,manifest:'d'.repeat(64)})).toBe(installationIdentity(row));
    });
    it('Очередь проверки и очередь изменений не смешивают виды заданий и папки',()=>{
        const other={...job,id:'other',bindingId:bindingA};
        const mutation={...job,id:'install',kind:'install'};
        expect(latestInspectionJob([other,mutation,job],row)?.id).toBe('job');
        expect(latestAssetJob([other,job,mutation],row)?.id).toBe('install');
        expect(latestInspectionJob([other],row)).toBeUndefined();
        expect(latestAssetJob([{...mutation,bindingId:bindingA}],row)).toBeUndefined();
    });
    it('Текущий badge не принимает прежнюю или неизвестную папку',()=>{
        expect(currentInstallation([{...row,bindingId:bindingA},row],row)).toBe(row);
        expect(currentInstallation([{...row,legacyBinding:true}],row)).toBeUndefined();
        expect(hasCurrentBinding({...row,bindingId:bindingA},device)).toBe(false);
        expect(hasCurrentBinding({...row,bindingId:null,legacyBinding:true},device)).toBe(false);
    });
    it('Открытое подтверждение старой папки не разрешает удаление из новой',()=>{
        const selected={...row,bindingId:bindingA,folderName:'Папка А'};
        expect(removalSelection(selected,[selected,row],device)).toBeUndefined();
        expect(selected.folderName).toBe('Папка А');
        expect(removalSelection(row,[row],device)).toBe(row);
    });
    it.each([{version:3},{manifest:'d'.repeat(64)},{isCurrentBinding:false},{bindingChanged:true}])('Переобновлённая строка отменяет прежнее подтверждение: %j',changes=>{
        expect(removalSelection(row,[{...row,...changes}],device)).toBeUndefined();
    });
    it('Запросы всегда передают исходную привязку и пакетный хэш',()=>{
        for(const kind of ['uninstall','inspect-installation'] as const){
            expect(installationRequest(kind,row,'request')).toEqual({kind,deviceId:row.deviceId,projectId:row.projectId,assetId:row.assetId,assetKind:row.assetKind,
                expectedManifest:row.manifest,expectedBindingId:bindingB,requestKey:'request'});
        }
        expect(()=>installationRequest('uninstall',{...row,bindingId:null},'request')).toThrow('неизвестной папке');
    });
});

describe('Честные результаты сверки файлов',()=>{
    it('Сверка файлов показывает время и не выдаёт инструмент за запущенный',()=>{
        const html=renderToStaticMarkup(createElement(InstallationInspectionStatus,{item:{...row,inspection}}));
        expect(html).toContain('Файлы сверены'); expect(html).toContain('Проверка:'); expect(html).toContain('Запуск в OpenCode не проверен');
        expect(html).not.toContain('ant-tag-green'); expect(html).not.toContain('Готов к работе');
    });
    it.each([
        [{status:'modified'},'Есть изменения в установке'],[{status:'missing'},'Часть установки отсутствует'],
        [{status:'unknown'},'Проверка не дала полного результата'],[{state:'busy'},'Проверка отложена'],
    ] as const)('Неполный результат не становится успешной сверкой: %j',(changes,label)=>{
        const html=renderToStaticMarkup(createElement(InstallationInspectionStatus,{item:{...row,inspection:{...inspection,...changes}}}));
        expect(html).toContain(label); expect(html).not.toContain('Файлы сверены'); expect(html).toContain('Запуск в OpenCode не проверен');
    });
    it.each([{bindingId:bindingA},{version:1},{manifest:'f'.repeat(64)},{assetId:'ai-plug-other'},{projectId:'other'},{checkedAt:'bad'}])('Старый или неполный отчёт не подтверждает текущую установку: %j',changes=>{
        expect(matchingInspection({...row,inspection:{...inspection,...changes}})).toBeUndefined();
    });
    it('Произвольная ошибка сервера не попадает в пользовательский результат',()=>{
        const bad={...inspection,issues:['/private/secret-token']} as unknown as IInstallationInspection;
        const html=renderToStaticMarkup(createElement(InstallationInspectionStatus,{item:{...row,inspection:bad}}));
        expect(html).not.toContain('secret-token'); expect(html).toContain('Файлы ещё не сверены');
    });
    it('Фиксированный код получает понятное сообщение без пути и содержимого файла',()=>{
        const html=renderToStaticMarkup(createElement(InstallationInspectionStatus,{item:{...row,inspection:{...inspection,status:'modified',issues:['file-modified','config-modified']}}}));
        expect(html).toContain('Файлы изменены после установки'); expect(html).toContain('Подключение OpenCode изменено вручную');
    });
});

describe('Кнопки проверки файлов в личной истории',()=>{
    it('Наблюдатель с правом чтения видит доступную проверку и не получает удаление',()=>{
        expect(inspectionBlocker(device)).toBe(''); expect(installationBlocker(device)).toContain('Роль');
        const html=render(); expect(buttons(html,'Проверить файлы')).toHaveLength(1); expect(buttons(html,'Проверить файлы')[0]).not.toContain('disabled');
        expect(buttons(html,'Удалить с компьютера')).toHaveLength(0);
    });
    it('Текущая папка показана первой, прежние находятся в сворачиваемой истории без повторных действий',()=>{
        const html=render([row,{...row,bindingId:bindingA,folderName:'Папка А',isCurrentBinding:false},{...row,bindingId:null,folderName:undefined,legacyBinding:true}]);
        const checks=buttons(html,'Проверить файлы'); expect(checks).toHaveLength(1);
        expect(checks.filter(attributes=>!attributes.includes('disabled'))).toHaveLength(1);
        expect(html).toContain('Папка А'); expect(html).toContain('Папка Б'); expect(html).toContain('Привязка неизвестна');
        expect(html).toContain('История других папок (2)');
        expect(html.indexOf('Папка Б')).toBeLessThan(html.indexOf('Папка А'));
    });
    it('Проверка из прежней папки не блокирует текущую строку',()=>{
        expect(buttons(render([row],[{...job,bindingId:bindingA}]),'Проверить файлы')[0]).not.toContain('disabled');
        expect(buttons(render([row],[job]),'Проверить файлы')[0]).toContain('disabled');
    });
    it('Отсутствие inspection capability блокирует только проверку, удаление остаётся доступным разработчику',()=>{
        const target={...device,role:'Разработчик',report:{...device.report,capabilities:device.report.capabilities?.filter(cap=>cap!=='installation-inspection-v1')}};
        const html=render([row],[],target,true); expect(buttons(html,'Проверить файлы')[0]).toContain('disabled');
        expect(buttons(html,'Удалить с компьютера')[0]).not.toContain('disabled');
        expect(html).toContain('Обновите мост');
    });
    it('Нет права чтения — нет кнопки проверки',()=>{expect(buttons(render([row],[],device,false,false),'Проверить файлы')).toHaveLength(0);});
    it('Проверка требует работающего компьютера, удаление можно поставить в очередь',()=>{
        const target={...device,role:'Разработчик',online:false};
        const html=render([row],[],target,true); expect(buttons(html,'Проверить файлы')[0]).toContain('disabled');
        expect(buttons(html,'Удалить с компьютера')[0]).not.toContain('disabled');
    });
});
