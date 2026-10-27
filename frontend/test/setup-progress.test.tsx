import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {SetupProgress} from '../src/modules/Start/SetupProgress';
import type {useBridge} from '../src/features/McpBridge/useBridge';

const bridge=(patch:Record<string,unknown>={})=>({devices:[],devicesReady:true,errors:{devices:''},...patch}) as unknown as ReturnType<typeof useBridge>;
const render=(value:ReturnType<typeof useBridge>)=>renderToStaticMarkup(createElement(SetupProgress,{bridge:value}));

it('empty summary gives the computer next action without project or model placeholders',()=>{
    const html=render(bridge());expect(html).toContain('Подключите мост и выберите компьютер');
    expect(html).not.toContain('Выберите проект');expect(html).not.toContain('Агенты и модель');expect(html).not.toContain('Версия CLI пока');
});
it('selected computer shows its reported bridge version and fresh connection, never a guessed CLI version',()=>{
    const device={id:'qa-computer',name:'Рабочий Linux',online:true,report:{bridgeVersion:'0.4.25',runtimeVersion:'24.15.0'}};
    const html=render(bridge({device,devices:[device]}));expect(html).toContain('Рабочий Linux');expect(html).toContain('Мост 0.4.25');expect(html).toContain('На связи');
    expect(html).not.toContain('24.15.0');expect(html).not.toContain('opencode --version');
});
it('stale or missing report stays explicit and never claims the selected computer is ready',()=>{
    const device={id:'qa-computer',name:'Рабочий Linux',online:true,report:{bridgeVersion:'0.4.25'}};
    const stale=render(bridge({device,devices:[device],devicesReady:false,errors:{devices:'Controlled unavailable'}}));
    expect(stale).toContain('Статус не подтверждён');expect(stale).toContain('Последний отчёт: мост 0.4.25');expect(stale).not.toContain('На связи');
    expect(render(bridge({device:{...device,report:{}},devices:[device]}))).toContain('Версия моста не передана');
});
