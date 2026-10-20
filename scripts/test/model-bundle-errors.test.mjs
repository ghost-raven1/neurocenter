import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelBundleFailure} from '../models/bundle-errors.mjs';

test('Нехватка места показывает требуемое и доступное место с резервом',()=>{
    const failure=modelBundleFailure({code:'ENOSPC',requiredBytes:3*1024**3,availableBytes:2*1024**3});
    assert.equal(failure.code,'ENOSPC');assert.match(failure.message,/3.00 ГиБ.*2.00 ГиБ/);
    assert.match(failure.message,/резерв 1 ГиБ/);
    assert.equal(failure.requiredBytes,3*1024**3);assert.equal(failure.availableBytes,2*1024**3);
    assert.equal(modelBundleFailure({code:'ENOSPC',requiredBytes:-1,availableBytes:NaN}).requiredBytes,undefined);
});

test('Ошибка прав не маскируется советом освободить диск и не раскрывает сырое исключение',()=>{
    for(const code of ['EACCES','EPERM','EROFS','EDQUOT','ENOENT','ENOTDIR','ELOOP']) {
        const failure=modelBundleFailure({code,message:'PRIVATE /secret/token'});
        assert.equal(failure.code,code);assert.doesNotMatch(failure.message,/PRIVATE|secret/);
    }
    assert.match(modelBundleFailure({code:'EACCES'}).message,/прав.*data\/embedding/);
});

test('Причина fetch отличает DNS, TLS и ограничение времени',()=>{
    for(const code of ['ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT']) {
        assert.equal(modelBundleFailure({message:'fetch failed',cause:{code}}).code,'MODEL_NETWORK');
    }
    assert.equal(modelBundleFailure({message:'fetch failed',cause:{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'}}).code,'MODEL_TLS');
    assert.equal(modelBundleFailure({name:'TimeoutError',message:'PRIVATE timeout'}).code,'MODEL_DOWNLOAD_TIMEOUT');
});

test('HTTP-код GitHub сохраняется при передаче безопасной ошибки через JSON',()=>{
    for(const status of [403,404,429,502]) {
        const failure=modelBundleFailure(new Error(`GitHub не выдал часть модели (HTTP ${status}).`));
        assert.equal(failure.status,status);assert.match(failure.message,new RegExp(`HTTP ${status}`));
        assert.deepEqual(modelBundleFailure(JSON.parse(JSON.stringify(failure))),failure);
    }
});

test('Несовпадение SHA, проблема описи и символическая ссылка остаются различимыми',()=>{
    assert.equal(modelBundleFailure(new Error('SHA существующего файла модели не совпал. Данные сохранены.')).code,'MODEL_INTEGRITY');
    assert.equal(modelBundleFailure(new Error('Некорректная опись поставки моделей.')).code,'MODEL_MANIFEST');
    assert.equal(modelBundleFailure(new Error('Каталог модели заменён символической ссылкой.')).code,'MODEL_STORAGE');
});

test('Неизвестное исключение и поддельная публичная ошибка не выводят секреты',()=>{
    for(const error of [undefined,null,'PRIVATE',new Error('PRIVATE signed-url?token=hidden'),{code:'MODEL_NETWORK',message:'PRIVATE'}]) {
        const failure=modelBundleFailure(error);assert.ok(failure.message);assert.doesNotMatch(failure.message,/PRIVATE|token|hidden/);
    }
});


test('Конфликт чужого тега не предлагает удалённый legacy путь и не раскрывает исходную ошибку',()=>{
    const result=modelBundleFailure({code:'MODEL_MANAGED_CONFLICT',message:'PRIVATE /models/token'});
    assert.equal(result.code,'MODEL_MANAGED_CONFLICT');assert.match(result.message,/immutable alias/);assert.doesNotMatch(result.message,/PRIVATE|token/);

});

test('Незавершённое переключение сохраняет конкретную команду восстановления в JSON',()=>{
    const result=modelBundleFailure({code:'MODEL_RECOVERY_REQUIRED',message:'PRIVATE /models/token'});
    assert.equal(result.code,'MODEL_RECOVERY_REQUIRED');assert.match(result.message,/npm run models:prepare -- --directory <каталог моделей> --recover-only/);
    assert.doesNotMatch(result.message,/PRIVATE|token|models:sync/);
    assert.deepEqual(modelBundleFailure(JSON.parse(JSON.stringify(result))),result);
});
