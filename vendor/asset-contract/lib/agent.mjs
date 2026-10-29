import {object,text} from './validation.mjs';
const permissions=['read','edit','bash','glob','grep','list','task','external_directory','todowrite','question','webfetch','websearch','lsp','doom_loop','skill'];
/** OpenCode 1.14.48 native agent schema; source assets contain no deployment credentials. */
export function validateAgentDelivery(asset){
  const card=object(asset.card,['id','slug','name','definition'],'Agent card');
  if(card.id!==asset.id||!/^agent-[a-z0-9][a-z0-9-]{0,120}$/.test(card.id)||typeof card.slug!=='string'||card.slug.length>64||!/^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card.slug))throw new Error('Agent identity requires the reserved nc- namespace');
  text(card.name,'Agent name',128);if(Buffer.from(card.name,'utf8').toString('utf8')!==card.name)throw new Error('Invalid agent name Unicode');
  const definition=object(card.definition,['description','prompt','mode','model','temperature','topP','steps','permission'],'Agent definition');
  if(typeof definition.description!=='string'||!definition.description.trim()||Buffer.byteLength(definition.description)>1024||Buffer.from(definition.description,'utf8').toString('utf8')!==definition.description||/[\x00-\x1f\x7f]/.test(definition.description))throw new Error('Invalid agent description');
  if(typeof definition.prompt!=='string'||!definition.prompt.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(definition.prompt)||Buffer.byteLength(definition.prompt)>65536||Buffer.from(definition.prompt,'utf8').toString('utf8')!==definition.prompt)throw new Error('Invalid agent prompt');
  if(!['primary','subagent','all'].includes(definition.mode))throw new Error('Invalid agent mode');
  if(definition.model!==undefined&&(typeof definition.model!=='string'||definition.model.length>200||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(definition.model)||definition.model.includes('://')))throw new Error('Model must be a provider/model identifier');
  for(const [key,max]of [['temperature',2],['topP',1]])if(definition[key]!==undefined&&(!Number.isFinite(definition[key])||definition[key]<0||definition[key]>max))throw new Error('Invalid agent '+key);
  if(definition.steps!==undefined&&(!Number.isSafeInteger(definition.steps)||definition.steps<1||definition.steps>1000))throw new Error('Invalid agent steps');
  object(definition.permission,permissions,'Agent permissions');
  if(Object.values(definition.permission).some(value=>!['allow','ask','deny'].includes(value)))throw new Error('Agent permissions require explicit allow, ask or deny');
  object(asset.delivery,['type'],'Agent delivery');if(asset.delivery.type!=='inline')throw new Error('Agents require inline delivery');
  if(asset.compatibility.bridgeProtocol!==2)throw new Error('Agent delivery requires bridge protocol 2');
}
