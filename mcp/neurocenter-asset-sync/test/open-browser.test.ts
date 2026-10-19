import {describe,expect,it} from 'vitest';
import {browserCommand} from '../src/bridge/open-browser.js';

describe('Переход из установщика к подтверждению компьютера',()=>{
    const url='http://localhost:5173/start?step=1&connect=0123456789ABCDEF';
    it.each([['darwin','open',[url]],['win32','rundll32.exe',['url.dll,FileProtocolHandler',url]],['linux','xdg-open',[url]]])('Открывает страницу в системе %s без shell', (platform,file,args)=>{
        expect(browserCommand(url,platform as string)).toEqual({file,args});
    });
    it.each(['javascript:alert(1)','file:///tmp/test','https://user:secret@example.test','https://example.test/\n--command'])('Отклоняет неподходящую ссылку %s',url=>{
        expect(()=>browserCommand(url,'darwin')).toThrow();
    });
});
