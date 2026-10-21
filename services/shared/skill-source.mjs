const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bytes=value=>new TextEncoder().encode(value).length;
const fileBytes=file=>{
 if(file.encoding===undefined)return bytes(file.content);
 if(file.encoding!=='base64'||typeof file.content!=='string'||file.content.length>4*Math.ceil(1024**2/3)||file.content.length%4||/[^A-Za-z0-9+/=]/.test(file.content))throw new Error('Ресурс скилла должен содержать канонический base64.');
 let decoded;try{decoded=atob(file.content);}catch{throw new Error('Ресурс скилла должен содержать канонический base64.');}
 if(btoa(decoded)!==file.content)throw new Error('Ресурс скилла должен содержать канонический base64.');return decoded.length;
};
const forbidden=/(?:^|\/)(?:\.git|node_modules|\.npmrc|\.yarnrc(?:\.yml)?|\.env(?:\..*)?|id_rsa|id_ed25519)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;

/** Candidate discovery never flattens a skill tree or silently chooses among several instructions. */
export function skillSourceEntrypoints(files){
 return Array.isArray(files)?files.filter(file=>typeof file?.path==='string'&&/(?:^|\/)SKILL\.md$/.test(file.path)).map(file=>file.path).sort():[];
}
/** Match the bridge preflight: local Markdown links must remain inside this exact delivered skill. */
export function validateSkillLinks(content,paths){
 const files=new Set(paths);
 for(const link of content.matchAll(/!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)){
  const raw=link[1]??'';
  if(!raw||raw.startsWith('#')||/^(?:https?|mailto):/i.test(raw))continue;
  if(/^[a-z][a-z0-9+.-]*:/i.test(raw))throw new Error('Скилл содержит запрещённую локальную ссылку.');
  let target;try{target=decodeURIComponent(raw.split(/[?#]/)[0]??'');}catch{throw new Error('Скилл содержит некорректное кодирование ссылки.');}
  if(target.startsWith('/')||target.includes('\\'))throw new Error('Локальная ссылка скилла выходит из его папки.');
  const parts=[];for(const part of target.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)throw new Error('Локальная ссылка скилла выходит из его папки.');parts.pop();}else parts.push(part);}
  if(!files.has(parts.join('/')))throw new Error('В скилле отсутствует файл локальной ссылки: '+target);
 }
}

/** One portable SKILL.md tree becomes the same inline native skill on server and in preview. */
export function parseSkillSource(files,overrides={},parseYaml){
 if(!Array.isArray(files)||!files.length||files.length>100)throw new Error('Скилл: от 1 до 100 текстовых файлов.');
 const seen=new Set();let total=0;
 for(const file of files){
  const name=file?.path;
  if(!object(file)||Object.keys(file).some(key=>!['path','content','encoding'].includes(key)))throw new Error('Ресурс скилла содержит неподдерживаемые поля.');
  if(typeof name!=='string'||!name||name.length>240||name!==name.trim()||name.startsWith('/')||name.includes('\\')||/[\x00-\x1f\x7f<>:"|?*]/.test(name)
   ||name.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||forbidden.test(name))throw new Error('Недопустимый или секретный путь ресурса скилла.');
  const lower=name.normalize('NFC').toLowerCase();
  if(seen.has(lower)||[...seen].some(other=>other.startsWith(lower+'/')||lower.startsWith(other+'/')))throw new Error('Пути ресурсов скилла конфликтуют.');
  seen.add(lower);
  if(typeof file.content!=='string'||file.content.includes('\0')||fileBytes(file)>1024**2)throw new Error('Ресурс скилла превышает 1 МиБ или имеет некорректное кодирование.');
  total+=fileBytes(file);if(total>5*1024**2)throw new Error('Скилл превышает 5 МиБ.');
 }
 const candidates=skillSourceEntrypoints(files),entrypoint=overrides.entrypoint??(candidates.length===1?candidates[0]:undefined);
 if(!entrypoint||!candidates.includes(entrypoint))throw new Error(candidates.length>1?'Найдено несколько SKILL.md. Выберите скилл для упаковки.':'В выбранных исходниках нужен файл SKILL.md.');
 const prefix=entrypoint.slice(0,-'SKILL.md'.length),selected=files.filter(file=>file.path.startsWith(prefix)).map(file=>({...file,path:file.path.slice(prefix.length)}));
 const instruction=selected.find(file=>file.path==='SKILL.md');
 if(instruction.encoding!==undefined)throw new Error('Инструкция SKILL.md должна быть текстом UTF-8.');
 if(selected.some(file=>file.path!=='SKILL.md'&&!/^(scripts|references|assets)\//.test(file.path)&&!/^(?:readme|licen[cs]e|notice)(?:\.[a-z0-9._-]+)?$/i.test(file.path)))throw new Error('Ресурсы скилла разместите в scripts/, references/ или assets/.');
 const normalized=instruction.content.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
 let meta={},body=normalized;
 if(normalized.startsWith('---\n')){
  const close=normalized.indexOf('\n---',4);
  if(close<0||!/^\n---(?:\n|$)/.test(normalized.slice(close)))throw new Error('В SKILL.md не закрыт YAML frontmatter.');
  if(typeof parseYaml!=='function')throw new Error('Разбор YAML скилла недоступен.');
  try{meta=parseYaml(normalized.slice(4,close));}catch{throw new Error('SKILL.md содержит некорректный YAML frontmatter.');}
  if(!object(meta))throw new Error('Frontmatter SKILL.md должен быть объектом.');
  body=normalized.slice(close+4).replace(/^\n/,'');
 }
 if(!body.trim())throw new Error('Инструкция SKILL.md пуста.');
 const slug=meta.slug??meta.name;
 if(typeof slug!=='string'||slug.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw new Error('В frontmatter SKILL.md нужен name или slug: до 64 латинских букв, цифр и одиночных дефисов.');
 const name=(overrides.name??meta.name??slug),rawDescription=overrides.description??meta.description;
 const description=typeof rawDescription==='string'?rawDescription.trim().replace(/[\r\n\t]+/g,' ').replace(/ {2,}/g,' '):rawDescription;
 if(typeof name!=='string'||!name.trim()||name.trim().length>128||/[\x00-\x1f\x7f]/.test(name))throw new Error('Название скилла: до 128 символов.');
 if(typeof description!=='string'||!description.trim()||description.length>1024||/[\x00-\x1f\x7f]/.test(description))throw new Error('Для скилла нужно описание до 1024 символов.');
 for(const key of ['mcp','plugins','dependencies'])if(meta[key]!==undefined&&(!Array.isArray(meta[key])||meta[key].length))throw new Error('Скилл с зависимостями добавляется через каталог ассетов с точными связанными версиями.');
 if(meta.tags!==undefined&&(!Array.isArray(meta.tags)||meta.tags.length>20||meta.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>128||/[\x00-\x1f]/.test(tag))))throw new Error('Теги скилла: до 20 непустых строк.');
 if(meta.specialization!==undefined&&(typeof meta.specialization!=='string'||meta.specialization.length>256))throw new Error('Специализация скилла: до 256 символов.');
 const resources=selected.filter(file=>/^(scripts|references|assets)\//.test(file.path)).map(({path,content,encoding})=>({path:path.normalize('NFC'),content,...(encoding?{encoding}:{})})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(resources.some(file=>file.path.length>200||bytes(file.path)>240))throw new Error('Путь ресурса скилла превышает допустимый размер.');
 if(resources.reduce((sum,file)=>sum+fileBytes(file),0)>4*1024**2)throw new Error('Ресурсы скилла превышают 4 МиБ.');
 if(bytes(`---\nname: ${JSON.stringify(slug)}\ndescription: ${JSON.stringify(description.trim())}\nmcp: []\nplugins: []\n---\n\n${body}`)>1024**2)throw new Error('Инструкция SKILL.md вместе с метаданными превышает 1 МиБ.');
 if(!overrides.metadataOnly)validateSkillLinks(body,['SKILL.md',...resources.map(file=>file.path)]);
 return {entrypoint,slug,name:name.trim().normalize('NFC'),description:description.trim(),body,
  meta:{description:description.trim(),tags:[...new Set((meta.tags??[]).map(tag=>tag.trim().normalize('NFC')))],mcp:[],plugins:[],...(meta.specialization?{specialization:meta.specialization}:{})},
  resources};
}
