import {describe,expect,it} from 'vitest';
import {isRemoteApiUrl,remoteModelOptions} from '../src/features/ModelCatalog/remoteModelForm';
import {parseProviderParameters} from '../src/features/ModelCatalog/adapterParameterForm';

it('Произвольные JSON поля адаптера сохраняют типы и не зависят от списка полей формы',()=>{
 const parameters=Object.fromEntries(Array.from({length:100},(_,index)=>['custom'+index,{enabled:false,value:null}]));
 expect(remoteModelOptions({apiFormat:'responses',reasoningEffort:'high',store:false,providerParameters:JSON.stringify(parameters)},{runtime:'remote-openai',capability:'chat'})).toEqual({apiFormat:'responses',reasoningEffort:'high',store:false,providerParameters:parameters});
 expect(remoteModelOptions({providerParameters:parameters},{runtime:'remote-ollama',capability:'embedding'})).toEqual({providerParameters:parameters});
 expect(remoteModelOptions({providerParameters:' '},{runtime:'remote-openai',capability:'chat'})).toEqual({});
});
it('JSON редактор отклоняет незавершённый JSON, массив и избыточный объём без потери структуры',()=>{
 for(const value of ['{','[]','null','{"x":"'+'x'.repeat(65536)+'"}'])expect(()=>parseProviderParameters(value)).toThrow();
 expect(parseProviderParameters('{"f":false,"n":null,"a":[0,"x"]}')).toEqual({f:false,n:null,a:[0,'x']});
});
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
 it.each(['chat','vision'] as const)('OpenAI %s сохраняет явно выбранные canonical model и параметр лимита без изменения числовых нулей',capability=>{
  expect(remoteModelOptions({responseModel:' canonical/model:v1 ',tokenLimitParameter:'max_completion_tokens',temperature:0,maxOutputTokens:64},{runtime:'remote-openai',capability})).toEqual({responseModel:'canonical/model:v1',tokenLimitParameter:'max_completion_tokens',temperature:0,maxOutputTokens:64});
 });
 it('Embedding OpenAI сохраняет только responseModel, без генерационных параметров',()=>{
  expect(remoteModelOptions({responseModel:' canonical-embedding ',tokenLimitParameter:'max_tokens',temperature:1,maxOutputTokens:64},{runtime:'remote-openai',capability:'embedding'})).toEqual({responseModel:'canonical-embedding'});
 });
 it('Ollama не получает OpenAI compatibility поля, очищенные OpenAI поля не меняют legacy options',()=>{
  expect(remoteModelOptions({responseModel:'canonical',tokenLimitParameter:'max_completion_tokens',temperature:0},{runtime:'remote-ollama',capability:'chat'})).toEqual({temperature:0});
  expect(remoteModelOptions({responseModel:' ',tokenLimitParameter:null},{runtime:'remote-openai',capability:'chat'})).toEqual({});
 });
 it.each(['http://localhost:11434','http://127.0.0.1:11434','http://10.0.0.2:11434','http://models.internal:8080/v1','https://provider.example/v1'])('Разрешает явный private/self-hosted API %s',value=>{expect(isRemoteApiUrl(value)).toBe(true);});
 it.each(['','localhost:11434','file:///private/key','https://user:secret@example.test','https://example.test/v1?key=secret','https://example.test/#secret','https://example.test/\n'])('Не прячет секрет в адресе %s',value=>{expect(isRemoteApiUrl(value)).toBe(false);});
 it('RAG принимает verified remote pin и блокирует непроверенную, чужую размерность и chat',()=>{
  const model={runtime:'remote-openai',capability:'embedding',dimension:1536,modelVersion:'v1',manifestSha256:null,verificationSha256:'a'.repeat(64)} as ICatalogModel;
  expect(eligibleEmbedding(model,1536)).toBe(true);expect(eligibleEmbedding({...model,verificationSha256:null},1536)).toBe(false);
  expect(eligibleEmbedding(model,2560)).toBe(false);expect(eligibleEmbedding({...model,capability:'chat'},1536)).toBe(false);
 });
});
