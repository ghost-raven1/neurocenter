import { describe, expect, it } from 'vitest';

import { startQueryUrl, startStep } from '../src/modules/Start/startQuery';

describe('Адрес первого подключения', () => {
    it.each(['', '?step=-1', '?step=3', '?step=1.5', '?step=unknown'])('Неизвестный этап %s открывает начало', search => {
        expect(startStep(search)).toBe(0);
    });

    it.each([0, 1, 2])('Открывает этап %i из ссылки', step => {
        expect(startStep(`?step=${step}&p=example`)).toBe(step);
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
});
