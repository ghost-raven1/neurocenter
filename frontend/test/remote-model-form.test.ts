import {describe,expect,it} from 'vitest';
import {isRemoteApiUrl,remoteModelOptions} from '../src/features/ModelCatalog/remoteModelForm';
import {eligibleEmbedding} from '../src/features/ProjectEmbedding/model';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';

describe('Удалённая модель в форме и RAG выборе',()=>{
 it('Очищенные параметры используют defaults провайдера, явные нули сохраняются, неизвестные поля не уходят в API',()=>{
  const values={temperature:0,topP:0,maxOutputTokens:null,contextWindow:4096,unsupported:'ignore'};
  expect(remoteModelOptions(values,{runtime:'remote-openai',capability:'chat'})).toEqual({temperature:0,topP:0,contextWindow:4096});
  expect(remoteModelOptions({temperature:null,topP:undefined,contextWindow:4096},{runtime:'remote-ollama',capability:'vision'})).toEqual({contextWindow:4096});
  expect(remoteModelOptions(undefined,{runtime:'remote-openai',capability:'chat'})).toEqual({});
  expect(remoteModelOptions({temperature:1,maxOutputTokens:1024,contextWindow:4096},{runtime:'remote-ollama',capability:'embedding'})).toEqual({});
 });
 it.each(['chat','vision'] as const)('Размер окна OpenAI %s сохраняется явно, очищенное поле остаётся неизвестным',capability=>{
  expect(remoteModelOptions({contextWindow:4096},{runtime:'remote-openai',capability})).toEqual({contextWindow:4096});
  expect(remoteModelOptions({contextWindow:null},{runtime:'remote-openai',capability})).toEqual({});
  expect(remoteModelOptions({contextWindow:undefined},{runtime:'remote-openai',capability})).toEqual({});
 });
 it.each(['http://localhost:11434','http://127.0.0.1:11434','http://10.0.0.2:11434','http://models.internal:8080/v1','https://provider.example/v1'])('Разрешает явный private/self-hosted API %s',value=>{expect(isRemoteApiUrl(value)).toBe(true);});
 it.each(['','localhost:11434','file:///private/key','https://user:secret@example.test','https://example.test/v1?key=secret','https://example.test/#secret','https://example.test/\n'])('Не прячет секрет в адресе %s',value=>{expect(isRemoteApiUrl(value)).toBe(false);});
 it('RAG принимает verified remote pin и блокирует непроверенную, чужую размерность и chat',()=>{
  const model={runtime:'remote-openai',capability:'embedding',dimension:1536,modelVersion:'v1',manifestSha256:null,verificationSha256:'a'.repeat(64)} as ICatalogModel;
  expect(eligibleEmbedding(model,1536)).toBe(true);expect(eligibleEmbedding({...model,verificationSha256:null},1536)).toBe(false);
  expect(eligibleEmbedding(model,2560)).toBe(false);expect(eligibleEmbedding({...model,capability:'chat'},1536)).toBe(false);
 });
});
