import { describe, expect, it } from 'vitest';

import { startQueryUrl, startSetupRequested } from '../src/modules/Start/startQuery';
import { unifiedSetupStep } from '../src/modules/Start/projectSetupModel';

describe('Адрес первого подключения', () => {
    it.each(['', '?step=-1', '?step=4', '?step=1.5', '?step=unknown'])('Неизвестный этап %s открывает начало', search => {
        expect(unifiedSetupStep(search)).toBe(0);
    });

    it.each([0, 1, 2, 3])('Открывает основной этап %i из ссылки', step => {
        expect(unifiedSetupStep(`?setup=1&step=${step}&p=example`)).toBe(step);
    });

    it('Переход между этапами сохраняет проект, справку и якорь', () => {
        expect(startQueryUrl('?step=2&p=prj-example&extension=rag', { step: 0 }, '#setup'))
            .toBe('/start?step=0&p=prj-example&extension=rag#setup');
    });

    it('Новый выбор проекта сохраняет текущий этап и параметры ссылки', () => {
        const url = startQueryUrl('?step=2&p=old&from=rag', { project: 'проект + код' }, '#tools');
        const parsed = new URL(url, 'http://localhost');
        expect(parsed.pathname).toBe('/start');
        expect(parsed.searchParams.get('p')).toBe('проект + код');
        expect(parsed.searchParams.get('step')).toBe('2');
        expect(parsed.searchParams.get('from')).toBe('rag');
        expect(parsed.hash).toBe('#tools');
    });

    it('Переход из старой ссылки сохраняет pairing и справку в основном мастере',()=>{
        const url=startQueryUrl('?legacy=1&step=2&p=проект&extension=rag&connect=PAIR&help=bridge',{setup:true,step:1},'#computer');
        const parsed=new URL(url,'https://qa.example.test');
        expect(parsed.searchParams.has('legacy')).toBe(false);
        expect(parsed.searchParams.get('p')).toBe('проект');expect(parsed.searchParams.get('extension')).toBe('rag');
        expect(parsed.searchParams.get('connect')).toBe('PAIR');expect(parsed.searchParams.get('help')).toBe('bridge');expect(parsed.hash).toBe('#computer');
        expect(startSetupRequested(parsed.search)).toBe(true);expect(unifiedSetupStep(parsed.search)).toBe(1);
        const closed=startQueryUrl(parsed.search,{setup:false,step:0,addComputer:false},parsed.hash),collapsed=new URL(closed,'https://qa.example.test');
        expect(startSetupRequested(collapsed.search)).toBe(false);expect(collapsed.searchParams.get('connect')).toBe('PAIR');expect(collapsed.hash).toBe('#computer');
        expect(startSetupRequested(new URL(startQueryUrl(collapsed.search,{setup:true,step:1},collapsed.hash),'https://qa.example.test').search)).toBe(true);
    });
});
