import {describe,expect,it} from 'vitest';
import {storeCardPlatforms,storeCardRevision,storeCardSource} from '../src/modules/Store/storeCardPresentation';

const artifact={target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'runtime/index.mjs'};

describe('Факты карточки из подтверждённых метаданных',()=>{
 it('Показывает исходный публичный репозиторий и npm-пакет без токена из URL',()=>{
  expect(storeCardSource('https://github.com/Team/tool.git?token=secret#private')).toEqual({label:'GitHub · Team/tool',href:'https://github.com/Team/tool'});
  expect(storeCardSource('https://www.npmjs.com/package/@team/tool?token=secret')).toEqual({label:'npm · @team/tool',href:'https://www.npmjs.com/package/@team/tool'});
 });
 it('Не раскрывает локальный путь, UUID загрузки или внутренний ключ рецепта',()=>{
  for(const origin of ['neurocenter:tool-builder','neurocenter:recipe/tool-'+'a'.repeat(32)]){
   expect(storeCardSource(origin)).toEqual({label:'Упакован в Нейроцентре'});
  }
  expect(storeCardSource('neurocenter:catalog-plugins')).toEqual({label:'Нейроцентр'});
  for(const origin of ['/Users/alex/private/source.zip','upload:7a870b31-5f2d-4434-9c97-cd5056dc1056','neurocenter:recipe/../../private'])expect(storeCardSource(origin)).toBeUndefined();
 });
 it.each(['https://github.com.attacker.example/team/tool','http://github.com/team/tool','https://user:secret@github.com/team/tool','https://github.com:8443/team/tool','https://example.org/private?key=secret','javascript:alert(1)','https:\\github.com\\team\\tool','https://github.com/team/%2fprivate',' https://github.com/team/tool','https://github.com/team/tool\n','https://www.npmjs.com/package/@team/../private','not an URL'])('Прячет неподтверждённый адрес %s',origin=>{
  expect(storeCardSource(origin)).toBeUndefined();
 });
 it('Не выдаёт commit или SHA исходников за версию инструмента',()=>{
  for(const revision of [null,undefined,'','main','git-'+'a'.repeat(40),'source-'+'b'.repeat(64),'build-'+'c'.repeat(64),'a'.repeat(40),'1.2.3+'+'b'.repeat(64),'private/source.zip'])expect(storeCardRevision(revision)).toBeUndefined();
  for(const revision of ['1.2.3','v2.0.0','1.2.3-beta.2','2.4.4-pack.1'])expect(storeCardRevision(revision)).toBe(revision);
 });
 it('Показывает только платформы из полной валидной декларации без расширения совместимости',()=>{
  expect(storeCardPlatforms({extra:{runtimeArtifacts:[artifact,{...artifact,target:'linux-x64-glibc'},{...artifact,target:'linux-arm64-musl'}]}})).toEqual({label:'macOS · Linux',title:'macOS · Apple Silicon, Linux · x64 · glibc, Linux · ARM64 · musl'});
  expect(storeCardPlatforms()).toBeUndefined();
  for(const runtimeArtifacts of [{schemaVersion:99,targets:['Windows']},[],[{target:'win32-x64'}],[{...artifact,target:'win32-quantum'}],[artifact,artifact],[{...artifact,sha256:'bad'}]])expect(storeCardPlatforms({extra:{runtimeArtifacts}})).toBeUndefined();
 });
});
