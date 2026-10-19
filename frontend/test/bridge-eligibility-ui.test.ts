import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeSync } from '../src/features/McpBridge/KnowledgeSync';
import { LocalProjectsFolder } from '../src/modules/Projects/local/LocalProjectsFolder';
import { BridgeSetup } from '../src/modules/Start/BridgeSetup';
import type { IBridgeJob } from '../src/features/McpBridge/api';

const fixture = vi.hoisted(() => {
    const device = {id:'fixture',name:'Компьютер',role:'Разработчик',fingerprint:'',online:true,lastSeen:null,report:{
        bridgeVersion:'0.4.1',protocolVersion:2,capabilities:['durable-completions','managed-installations','package-v4'],
        root:'/fixture/projects',bindings:[{projectId:'project',folderName:'local-project',valid:true,bindingId:'binding'}],
    }};
    return {bridge:{device,devices:[device],devicesReady:true,jobsReady:true,installationsReady:true,jobs:[] as IBridgeJob[],installations:[],
        loading:false,errors:{devices:'',jobs:'',installations:''},choose:vi.fn(),reload:vi.fn()}};
});
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>fixture.bridge}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:vi.fn(),location:{pathname:'/projects'}})}));

function buttonAttributes(html: string, text: string): string {
    const match = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(item => item[2].includes(text));
    expect(match, `Кнопка «${text}» присутствует`).toBeDefined();
    return match?.[1] ?? '';
}

describe('Общие действия MCP 0.4 без поддержки комплектов', () => {
    beforeEach(()=>{fixture.bridge.device.role='Разработчик';fixture.bridge.jobs=[];});
    it('Выбор общей папки остаётся доступен',()=>{
        const html=renderToStaticMarkup(createElement(LocalProjectsFolder,{project:null,onClose:vi.fn(),onBindings:vi.fn()}));
        expect(buttonAttributes(html,'Выбрать другую папку')).not.toContain('disabled');
        expect(html).toContain('Обновите мост');
    });
    it('Обе синхронизации базы знаний доступны при правильной привязке',()=>{
        const html=renderToStaticMarkup(createElement(KnowledgeSync,{projectId:'project',canWrite:true}));
        expect(buttonAttributes(html,'Скачать в проект через мост')).not.toContain('disabled');
        expect(buttonAttributes(html,'Синхронизировать с сервером')).not.toContain('disabled');
    });
    it('На странице начала работы обновление установщика не блокирует переход к папкам',()=>{
        const html=renderToStaticMarkup(createElement(BridgeSetup,{command:'fixture-installer',onCopy:vi.fn()}));
        expect(buttonAttributes(html,'Связать папку проекта')).not.toContain('disabled');
        expect(html).toContain('Обновите или переподключите мост');
    });
    it('Роль наблюдателя по-прежнему блокирует общие действия',()=>{
        fixture.bridge.device.role='Наблюдатель';
        const folders=renderToStaticMarkup(createElement(LocalProjectsFolder,{project:null,onClose:vi.fn(),onBindings:vi.fn()}));
        const sync=renderToStaticMarkup(createElement(KnowledgeSync,{projectId:'project',canWrite:true}));
        expect(buttonAttributes(folders,'Выбрать другую папку')).toContain('disabled');
        expect(buttonAttributes(sync,'Скачать в проект через мост')).toContain('disabled');
    });
    it('Отсутствие прав проекта сохраняет запрет синхронизации независимо от версии MCP',()=>{
        const html=renderToStaticMarkup(createElement(KnowledgeSync,{projectId:'project',canWrite:false}));
        expect(buttonAttributes(html,'Синхронизировать с сервером')).toContain('disabled');
    });
    it('Прошлый отказ выбора папки обозначен датированным результатом, а не текущим статусом', () => {
        fixture.bridge.jobs=[{id:'job',deviceId:'fixture',projectId:null,kind:'choose-root',state:'failed',message:'Выбор отменён',createdAt:'2026-10-18T00:00:00Z',updatedAt:'2026-10-18T01:00:00Z'}];
        const html=renderToStaticMarkup(createElement(LocalProjectsFolder,{project:null,onClose:vi.fn(),onBindings:vi.fn()}));
        expect(html).toContain('Последний выбор папки');
        expect(html).toContain('dateTime="2026-10-18T01:00:00Z"');
        expect(html).toContain('Выбор отменён');
    });
});
