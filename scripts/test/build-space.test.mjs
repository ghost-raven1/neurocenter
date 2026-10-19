import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertBuildSpace,MIN_BUILD_FREE_BYTES} from '../production/build-space.mjs';

test('Большой общий свободный объём не скрывает недоступные процессу зарезервированные блоки',()=>{
    assert.throws(()=>assertBuildSpace({bsize:4096n,bavail:0n,bfree:100n*1024n**3n/4096n}),/доступно 0\.00 ГиБ/);
});
test('Запас ровно 6 ГиБ допускает сборку, один недостающий блок останавливает её',()=>{
    const blocks=MIN_BUILD_FREE_BYTES/4096n;
    assert.doesNotThrow(()=>assertBuildSpace({bsize:4096n,bavail:blocks}));
    assert.throws(()=>assertBuildSpace({bsize:4096n,bavail:blocks-1n}),/Освободите место/);
});
