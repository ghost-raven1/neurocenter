import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,describe,expect,it,vi} from 'vitest';
import api from '../src/core/api/base';
import {loadBridgeInstallerOrigin} from '../src/features/McpBridge/useBridgeInstaller';
import {BridgeInstallerCommand} from '../src/features/McpBridge/BridgeInstallerCommand';
import {openCodeInstallerCommand} from '../src/features/McpBridge/connectionCommands';

vi.mock('../src/core/api/base',()=>({default:{get:vi.fn()}}));
afterEach(()=>vi.resetAllMocks());

describe('Runtime-адрес установщика Gateway',()=>{
    it.each(['http://localhost:4000','https://panel.example.test','https://gateway.example.test:8443'])('Принимает настроенный origin %s без привязки к сборке Vite',async origin=>{
        vi.mocked(api.get).mockResolvedValue({data:{origin}});
        const signal=new AbortController().signal;
        expect(await loadBridgeInstallerOrigin(signal)).toBe(origin);
        expect(api.get).toHaveBeenCalledWith('/api/bridge/config',{signal,timeout:10000});
    });
    it.each([undefined,null,{},[],{origin:1},{origin:'https://owner:secret@host.test'},{origin:'https://host.test/path'},
        {origin:'https://host.test?other=1'},{origin:'https://host.test#fragment'},{origin:'file:///tmp/bridge'},
        {origin:'javascript:alert(1)'},{origin:'https://host.test/'},{origin:'not a URL'}])('Отклоняет некорректный runtime-ответ %j',async data=>{
        vi.mocked(api.get).mockResolvedValue({data});
        await expect(loadBridgeInstallerOrigin(new AbortController().signal)).rejects.toThrow();
    });
    it('Ошибка сервера не подменяется адресом UI',async()=>{
        vi.mocked(api.get).mockRejectedValue(new Error('unavailable'));
        await expect(loadBridgeInstallerOrigin(new AbortController().signal)).rejects.toThrow('unavailable');
    });
    it.each([false,true])('OpenCode использует Gateway для windows=%s',windows=>{
        const command=openCodeInstallerCommand('http://localhost:4000',windows);
        expect(command).toContain(`http://localhost:4000/api/bridge/install_opencode.${windows?'ps1':'sh'}`);
        expect(command).not.toContain('5173');
    });
    it('Загрузка и ошибка не показывают команду и кнопку копирования',()=>{
        for(const installer of [{loading:true,error:''},{loading:false,error:'Gateway недоступен'}]){
            const html=renderToStaticMarkup(createElement(BridgeInstallerCommand,{installer:{...installer,reload:vi.fn()},windows:false,onCopy:vi.fn()}));
            expect(html).not.toMatch(/curl|install\.sh|Копировать команду/);
            expect(html).toContain(installer.loading?'Получаем адрес установщика':'Повторить загрузку');
        }
    });
    it.each([false,true])('Готовая команда использует Gateway, включая reconnect и windows=%s',windows=>{
        const html=renderToStaticMarkup(createElement(BridgeInstallerCommand,{installer:{origin:'http://localhost:4000',loading:false,error:'',reload:vi.fn()},windows,reconnect:true,onCopy:vi.fn()}));
        expect(html).toContain(`http://localhost:4000/api/bridge/install.${windows?'ps1':'sh'}?reconnect=1`);
        expect(html).toContain('Копировать команду');
    });
});
