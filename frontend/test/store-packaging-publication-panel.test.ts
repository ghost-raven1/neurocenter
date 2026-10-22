import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {PackagingPublicationPanel} from '../src/modules/Store/packaging/PackagingPublicationPanel';
import type {BuildPublicationTargetPreview} from '../src/modules/Store/packaging/types';

const preview:BuildPublicationTargetPreview={catalogId:'native-tool',name:'Инструмент',description:'Описание',kind:'plugin',expectedVersion:10,expectedSourceHash:'a'.repeat(64),sourceSummaries:[],updateSupported:true};
function render(confirmed:boolean){
    const publication={target:{catalogId:preview.catalogId,kind:preview.kind},preview,
        selection:confirmed?{catalogId:preview.catalogId,name:preview.name,kind:preview.kind,expectedVersion:preview.expectedVersion,expectedSourceHash:preview.expectedSourceHash}:undefined,
        loading:false,error:'',blocked:!confirmed,select:vi.fn(),confirm:vi.fn(),restore:vi.fn(),clear:vi.fn(),refresh:vi.fn()};
    return renderToStaticMarkup(createElement(PackagingPublicationPanel,{publication,disabled:false,onConfirm:vi.fn()}));
}

describe('Подпись подтверждённой редакции публикации',()=>{
    it('Подтверждённая редакция — основа запроса, а не текущий head после публикации следующей',()=>{
        const html=render(true);
        expect(html).toContain('На основе редакции 10');expect(html).not.toContain('Текущая редакция');
        expect(html).toContain('Версии в проектах и на компьютерах сохранятся');
        expect(html).not.toContain('Предыдущая редакция и её исходники');expect(html).not.toContain('Подтвердите инструмент, затем');
        expect(html).not.toContain('Публикация начнётся только кнопкой внизу');expect(html).toContain('Обновить цель');
    });
    it('Предпросмотр отличает редакцию каталога от согласия и объясняет явное подтверждение',()=>{
        const html=render(false);
        expect(html).toContain('В каталоге редакция 10');expect(html).toContain('Подготовить новую версию');
        expect(html).toContain('Обновление цели требует нового подтверждения');expect(html).toContain('Публикация начнётся только кнопкой внизу');
    });
});
