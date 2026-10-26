import {describe,expect,it} from 'vitest';
import {agentToolAction} from '../src/agent-tools/agent-tools.validation';

const grant={protocol:'json-actions-v1' as const,rag:true};
/** Complete presentation wrappers never grant actions, repair JSON or allow surrounding prose. */
describe('Agent tool JSON presentation',()=>{
 it.each([
  ['```json\n{"action":"finish"}\n```',{action:'finish'}],
  ['  ```JSON\r\n{"action":"rag_search","query":"ledger"}\r\n``` \n',{action:'rag_search',query:'ledger'}],
  ['```\n{"action":"rag_read","sourceId":"found"}\n```',{action:'rag_read',sourceId:'found'}],
 ] as const)('accepts one complete JSON document inside a whole Markdown block: %s',(content,action)=>{
  expect(agentToolAction(content,grant)).toEqual(action);
 });
 it.each([
  'Привет!', '', 'Before\n```json\n{"action":"finish"}\n```',
  '```json\n{"action":"finish"}\n```\nAfter',
  '```json\n{"action":"finish"}\n```\n```json\n{"action":"finish"}\n```',
  '```javascript\n{"action":"finish"}\n```', '```json\n{"action":"finish"',
  '```json\n{"action":"finish"\n```', '{"action":"finish"} {"action":"finish"}',
 ])('rejects text, partial documents and multiple blocks without guessing: %s',content=>{
  expect(()=>agentToolAction(content,grant)).toThrow('Модель вернула ответ не в формате JSON шага инструмента');
 });
 it.each([
  '```json\n{"action":"mcp_call","tool":"shell"}\n```',
  '```json\n{"action":"finish","changes":[1]}\n```',
  '```json\n{"action":"public_chat_search","query":"private"}\n```',
  '```json\n[{"action":"finish"}]\n```',
 ])('retains action schema and grant restrictions inside a wrapper: %s',content=>{
  expect(()=>agentToolAction(content,grant)).toThrow('Шаг не входит');
 });
 it('reports the byte bound separately and keeps model content out of errors',()=>{
  const content=JSON.stringify({action:'rag_search',query:'secret '.repeat(1500)});
  expect(()=>agentToolAction(content,grant)).toThrow('Ответ шага инструмента превышает предел 8 КиБ');
  for(const invalid of [content,'Bearer private-token /Users/private/model']){
   try{agentToolAction(invalid,grant);throw Error('Expected validation error');}
   catch(error){expect(String(error)).not.toMatch(/secret|Bearer|private-token|\/Users/);expect(String(error)).toContain('Автоматического повтора нет');}
  }
 });
});
