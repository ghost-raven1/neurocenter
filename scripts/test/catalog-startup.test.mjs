import assert from 'node:assert/strict';
import {test} from 'node:test';
import {syncStartupCatalog} from '../workspace/catalog-startup.mjs';

function setup(result) {
    const lines = [], calls = [];
    const output = Object.fromEntries(['success','warning','info'].map(level => [level, (...args) => lines.push({level,args})]));
    const run = (...args) => { calls.push(args); return result; };
    return {calls, lines, execute: () => syncStartupCatalog({node:'/node24',root:'/workspace',environment:{CATALOG_PG_URL:'private'},output},run)};
}

test('Код 1 поставки показывает причину и не прерывает запуск приложения', () => {
    const s = setup({status:1,stderr:'Не удалось скачать готовый комплект (HTTP 403).'});
    assert.deepEqual(s.execute(),{ok:false});
    assert.ok(s.lines.some(line => line.level==='warning' && line.args[0].includes('продолжится')));
    assert.ok(s.lines.some(line => line.args.includes('Не удалось скачать готовый комплект (HTTP 403).')));
    assert.ok(s.lines.some(line => line.args.includes('npm run tools:sync')));
    assert.equal(s.lines.some(line => line.level==='success'),false);
});
test('Ошибка запуска CLI и сигнал не выдаются за готовый каталог', () => {
    for (const result of [{error:new Error('CLI недоступен')},{status:null,signal:'SIGTERM'}]) {
        const s=setup(result);assert.equal(s.execute().ok,false);assert.equal(s.lines.some(line=>line.level==='success'),false);
    }
});
test('Конфликты отдельных карточек выводятся без ложного сообщения полного успеха', () => {
    const s=setup({status:0,stdout:JSON.stringify({ok:true,tools:[{key:'memory'}],partial:true,conflicts:[{name:'MCP Fetch',reason:'Источник не подтверждён'}]})});
    assert.deepEqual(s.execute(),{ok:true,partial:true});
    assert.ok(s.lines.some(line=>line.args[0]==='MCP Fetch' && line.args[1]==='Источник не подтверждён'));
    assert.equal(s.lines.some(line=>line.level==='success'),false);
    assert.ok(s.calls[0][1].includes('--skip-conflicts'));
});
test('Полная поставка подтверждается только корректным ответом CLI', () => {
    const s=setup({status:0,stdout:JSON.stringify({ok:true,tools:[],partial:false,conflicts:[]})});
    assert.deepEqual(s.execute(),{ok:true,partial:false});
    assert.equal(s.lines.filter(line=>line.level==='success').length,1);
});
test('Повреждённый ответ и пустой список заявленных конфликтов остаются предупреждением', () => {
    for(const stdout of ['{}','не JSON',JSON.stringify({ok:true,tools:[],partial:true,conflicts:[]}),
        JSON.stringify({ok:true,tools:[],partial:true,conflicts:[null]})]) {
        const s=setup({status:0,stdout});assert.equal(s.execute().ok,false);assert.equal(s.lines.some(line=>line.level==='success'),false);
    }
});
