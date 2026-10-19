/** Страница не получает сохранённые значения и не подключает внешние ресурсы. */
export const configurationPage = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Настройка MCP — Нейроцентр</title><style>body{margin:0;background:#f3f5fa;color:#15223b;font:16px system-ui}main{max-width:620px;margin:32px auto;padding:24px;background:white;border-radius:20px}label{display:block;margin:20px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aab4c8;border-radius:8px;font:inherit}input[type=checkbox]{width:auto}button{padding:12px 18px;margin-top:24px;border:0;border-radius:9px;background:#315ce7;color:white;font:inherit}small{display:block;color:#506078}#status{white-space:pre-wrap}@media(max-width:680px){main{margin:12px;padding:20px}}</style><main><h1>Настройка MCP</h1><p>Параметры останутся на этом компьютере. Сохранённые секреты не отображаются. Для замены введите новое значение, для удаления отметьте удаление.</p><form id="form"></form><p id="status" role="status">Подключаем локальную форму…</p></main><script>
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);let csrf='',revision=null,fields=[];
const status=document.querySelector('#status'),form=document.querySelector('#form');
async function send(route,body){const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-Configuration-CSRF':csrf},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.message||'Действие недоступно.');return result;}
(async()=>{try{
const session=await send('/session',{token});csrf=session.csrf;revision=session.revision;fields=session.fields;
document.querySelector('h1').textContent='Настройка: '+session.name;
for(const field of fields){
const label=document.createElement('label');label.textContent=field.label+(field.required?' *':'');
const input=document.createElement(field.type==='boolean'?'select':'input');input.id='field-'+field.id;input.name=field.id;
if(field.type==='boolean'){for(const [value,text]of [['','Сохранить текущее значение'],['true','Да'],['false','Нет']]){const option=document.createElement('option');option.value=value;option.textContent=text;input.append(option);}}
else{input.type=field.secret?'password':field.type==='number'?'number':field.type==='url'?'url':'text';input.autocomplete='off';if(field.type==='number')input.step='any';}
label.htmlFor=input.id;form.append(label,input);
const remove=document.createElement('input');remove.type='checkbox';remove.id='remove-'+field.id;
const removeLabel=document.createElement('label');removeLabel.htmlFor=remove.id;removeLabel.append(remove,document.createTextNode(' Удалить сохранённое значение'));form.append(removeLabel);
const hint=document.createElement('small');hint.textContent=field.configured?'Значение сохранено на этом компьютере.':'Параметр пока не задан.';form.append(hint);
}
const button=document.createElement('button');button.type='submit';button.textContent='Сохранить на этом компьютере';form.append(button);
status.textContent='Форма действует до '+new Date(session.expiresAt).toLocaleTimeString();
}catch{status.textContent='Локальная форма недоступна или срок подключения истёк. Откройте её заново из каталога.';}})();
form.addEventListener('submit',async event=>{
event.preventDefault();const updates={},remove=[];
for(const field of fields){const input=document.querySelector('#field-'+field.id);
if(document.querySelector('#remove-'+field.id).checked){remove.push(field.id);continue;}
if(input.value!=='')updates[field.id]=field.type==='boolean'?input.value==='true':field.type==='number'?Number(input.value):input.value;
}
const button=form.querySelector('button');button.disabled=true;
try{const result=await send('/save',{updates,remove,expectedRevision:revision});status.textContent=result.ready?'Настройка сохранена. Вернитесь в Нейроцентр и проверьте запуск MCP.':'Сохранено. Заполните обязательные параметры: '+result.missingFieldIds.join(', ');form.replaceChildren();}
catch{status.textContent='Сохранить не удалось: проверьте права, актуальность установки и срок формы. Откройте настройку заново.';button.disabled=true;}
});
</script></html>`;
