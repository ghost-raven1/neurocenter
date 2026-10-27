import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Router } from 'react-router-dom';
import { createMemoryHistory } from 'history';
import { describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice, IBridgeInstallation } from '../src/features/McpBridge/api';
import type { useBridge } from '../src/features/McpBridge/useBridge';
import { BridgeConnection } from '../src/features/McpBridge/BridgeConnection';
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: 'fixture', captureOwner: () => () => true }) }));
import { ProjectInstallationReadiness } from '../src/features/McpBridge/ProjectInstallationReadiness';
import { LocalInstallations } from '../src/features/McpBridge/LocalInstallations';
import { connectionBlocker, inspectionBlocker, inspectionNotice, installationBlocker } from '../src/features/McpBridge/readiness';
import { ProjectKnowledgeLink } from '../src/modules/Store/ProjectKnowledgeLink';

const navigation = vi.hoisted(() => ({ chooseFolder: undefined as (() => void) | undefined }));
vi.mock('antd', async original => {
    const actual = await original<typeof import('antd')>();
    return { ...actual, Button: (props: Parameters<typeof actual.Button>[0]) => {
        if (props.children === 'Выбрать папку проекта') { navigation.chooseFolder = props.onClick as () => void; }
        return createElement(actual.Button, props);
    } };
});

const device: IBridgeDevice = {id:'computer',name:'Компьютер',role:'Разработчик',fingerprint:'',online:true,lastSeen:null,
    report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','install-set-v1','workspace-instance-v1','installation-inspection-v1'],
        bindings:[{projectId:'project',folderName:'Папка',bindingId:'binding',valid:true}]}};
const installed: IBridgeInstallation = {deviceId:device.id,projectId:'project',assetId:'helper',assetKind:'mcp',version:1,
    manifest:'a'.repeat(64),bindingId:'binding',isCurrentBinding:true,updatedAt:'2026-10-18T00:00:00Z'};
function bridge(target: IBridgeDevice): ReturnType<typeof useBridge> {
    return {device:target,devices:[target],devicesReady:true,jobsReady:true,installationsReady:true,jobs:[],installations:[installed],
        error:'',errors:{devices:'',jobs:'',installations:''},loading:false,choose:vi.fn(),reload:vi.fn(async()=>undefined)};
}
function renderReadiness(target: IBridgeDevice, canInstall = true): string {
    const state = bridge(target);
    return renderToStaticMarkup(createElement(MemoryRouter,{initialEntries:['/store']},createElement(Fragment,null,
        createElement(BridgeConnection,{bridge:state,compact:true}),
        createElement(ProjectInstallationReadiness,{bridge:state,projectId:'project',canInstall}),
        createElement(LocalInstallations,{bridge:state,projectId:'project',canManage:canInstall,canInspect:true,connectionNoticeVisible:true,catalog:[],approved:new Set<string>()}))));
}
function alerts(html: string): string[] {
    return [...html.matchAll(/class="ant-alert-message"[^>]*>([\s\S]*?)<\/div>/g)].map(match=>match[1]);
}
function button(html: string, label: string): string {
    return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match=>match[2].includes(label))?.[1] ?? '';
}

describe('Общее предупреждение готовности каталога',()=>{
    it('Выбор папки ведёт к выбранному проекту, сохраняя название действия',()=>{
        const history = createMemoryHistory({initialEntries:['/store?p=dossier-ko']});
        const target={...device,report:{...device.report,bindings:[]}};
        navigation.chooseFolder=undefined;
        const html=renderToStaticMarkup(createElement(Router,{history},
            createElement(ProjectInstallationReadiness,{bridge:bridge(target),projectId:'prj-dossier-ko',canInstall:true})));
        expect(html).toContain('Выбрать папку проекта'); expect(navigation.chooseFolder).toBeDefined();
        navigation.chooseFolder?.(); expect(history.location.pathname+history.location.search).toBe('/start?setup=1&p=prj-dossier-ko');
        navigation.chooseFolder=undefined;
        renderToStaticMarkup(createElement(Router,{history},
            createElement(ProjectInstallationReadiness,{bridge:bridge(target),projectId:'prj-dossier-ko',canInstall:false})));
        expect(navigation.chooseFolder).toBeUndefined();
    });

    it('Старый MCP получает один шаг обновления без включения установки и проверки',()=>{
        const target={...device,report:{...device.report,capabilities:['durable-completions','managed-installations']}};
        const html=renderReadiness(target);
        expect(alerts(html).filter(text=>text.includes('Обновите мост'))).toHaveLength(1);
        expect(html).not.toContain('Компьютер и папка готовы');
        expect(installationBlocker(target)).toContain('Обновите');
        expect(inspectionBlocker(target)).toContain('Обновите');
        expect(button(html,'Проверить файлы')).toContain('disabled');
        expect(button(html,'Удалить с компьютера')).toContain('disabled');
    });
    it('Истёкшее подключение объясняется один раз и продолжает запрещать действия',()=>{
        const target={...device,requiresReconnect:true};
        expect(alerts(renderReadiness(target)).filter(text=>text.includes('истекло'))).toHaveLength(1);
        expect(inspectionBlocker(target)).toContain('истекло');
        expect(installationBlocker(target)).toContain('истекло');
    });
    it('Отдельное отсутствие проверки файлов остаётся в её разделе',()=>{
        const target={...device,report:{...device.report,capabilities:device.report.capabilities?.filter(value=>value!=='installation-inspection-v1')}};
        const html=renderReadiness(target);
        expect(connectionBlocker(target)).toBe('');
        expect(alerts(html)).toContain('Обновите мост на странице «Начало работы», чтобы проверять установленные файлы.');
        expect(button(html,'Проверить файлы')).toContain('disabled');
        expect(button(html,'Удалить с компьютера')).not.toContain('disabled');
    });
    it('Неподтверждённый статус блокирует проверку файлов без утверждения, что компьютер выключен',()=>{
        const state={...bridge({...device,online:false}),devicesReady:false,
            error:'Не удалось загрузить список компьютеров.',
            errors:{devices:'Не удалось загрузить список компьютеров.',jobs:'',installations:''}};
        const html=renderToStaticMarkup(createElement(MemoryRouter,null,createElement(Fragment,null,
            createElement(BridgeConnection,{bridge:state,compact:true}),
            createElement(ProjectInstallationReadiness,{bridge:state,projectId:'project',canInstall:true}),
            createElement(LocalInstallations,{bridge:state,projectId:'project',canManage:true,canInspect:true,connectionNoticeVisible:true,catalog:[],approved:new Set<string>()}))));
        const inspection=button(html,'Проверить файлы');
        expect(inspection).toContain('disabled');
        expect(inspection).toContain('title="Дождитесь загрузки подключения и очереди."');
        expect(inspection).not.toContain('включите компьютер');
        expect(alerts(html).some(text=>text.includes('не в сети')||text.includes('включите компьютер'))).toBe(false);
        expect(html).not.toContain('Компьютер и папка готовы');
    });
    it('Выключенный старый компьютер сохраняет отдельную причину проверки',()=>{
        const target={...device,online:false,report:{...device.report,capabilities:[]}};
        expect(connectionBlocker(target)).toContain('Обновите');
        expect(inspectionNotice(target,true)).toContain('включите компьютер');
    });
    it('Непривязанная папка и роль проекта сохраняют свои объяснения',()=>{
        const target={...device,report:{...device.report,bindings:[]}};
        expect(alerts(renderReadiness(target))).toContain('Выберите папку этого проекта на компьютере. После привязки одобренный инструмент устанавливается одним нажатием.');
        expect(alerts(renderReadiness(device,false)).some(text=>text.includes('нужна роль разработчика'))).toBe(true);
    });
    it('Наблюдателю недоступна установка, но доступная проверка остаётся разрешённой',()=>{
        const html=renderReadiness({...device,role:'Наблюдатель'},false);
        expect(button(html,'Проверить файлы')).not.toContain('disabled');
    });
});

describe('Пустой список локальных установок',()=>{
    it('Короткое состояние сохраняет сведения о папке и поиск найденных инструментов',()=>{
        const state={...bridge(device),installations:[]};
        const html=renderToStaticMarkup(createElement(LocalInstallations,{bridge:state,projectId:'project',canManage:true,canInspect:true,catalog:[],approved:new Set<string>()}));
        expect(html).toContain('В этом проекте нет установленных через мост инструментов');
        expect(html).toContain('Текущая папка: Папка');
        expect(html).toContain('Найдено в проекте');
        expect(html).not.toContain('ant-empty-image');
        expect(html).not.toContain('Сверка файлов и диагностика запуска выполняются отдельно');
    });
    it('При наличии установки остаётся пояснение отдельных проверок файлов и запуска',()=>{
        const html=renderReadiness(device);
        expect(html).toContain('Сверка файлов и диагностика запуска выполняются отдельно');
        expect(html).toContain('Проверить файлы');
        expect(html).not.toContain('В этом проекте нет установленных через мост инструментов');
    });
});

describe('Переход из каталога к единственному разделу знаний',()=>{
    it.each(['prj-example-project','project / комната?'])('Ссылка использует id выбранного проекта: %s',projectId=>{
        const html=renderToStaticMarkup(createElement(MemoryRouter,null,createElement(ProjectKnowledgeLink,{projectId})));
        const href = html.match(/href="([^"]+)"/)?.[1];
        expect(href).toBeDefined();
        const url = new URL(href!, 'http://localhost');
        expect(decodeURIComponent(url.pathname.slice('/projects/'.length))).toBe(projectId);
        expect(url.searchParams.get('tab')).toBe('rag');
        expect(html).not.toContain('Скачать в проект через мост');
        expect(html).not.toContain('Синхронизировать с сервером');
    });
});
