# Проверяет реальные назначения на временных проектах и удаляет только созданные записи.
import http.cookiejar
import json
import urllib.error
import urllib.request
import uuid
from pathlib import Path

base='http://localhost:5173'
jar=http.cookiejar.CookieJar()
client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
client.addheaders=[('Accept','text/html,application/json')]
created=[]
results=[]

def call(method,route,data=None,expected=200):
    body=None if data is None else json.dumps(data).encode()
    req=urllib.request.Request(base+route,data=body,method=method,headers={'Content-Type':'application/json','X-Neurocenter-Request':'1'})
    try:
        response=client.open(req,timeout=20)
        status=response.status
        raw=response.read()
        value=json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        status=error.code
        value=json.loads(error.read())
    assert status==expected,(method,route,status,value)
    return value

client.open(base+'/auth/login',timeout=20).read()
profile=call('GET','/auth/me')
email=profile['user']['email']
try:
    for label in ['администрирование','наблюдение','без назначения']:
        project=call('POST','/api/projects',{'name':'Проверка RBAC '+label+' '+uuid.uuid4().hex[:8]},201)
        created.append(project['id'])
        Path('.run/access-smoke-projects.json').write_text(json.dumps(created))
    for project,role in zip(created[:2],['Админ проекта','Наблюдатель']):
        call('POST',f'/api/projects/{project}/members',{'principalName':email,'role':role},201)
    call('POST','/auth/switch-role',{'role':'Разработчик'},403)
    results.append({'case':'Неназначенная роль запрещена','status':403})
    call('POST','/auth/switch-role',{'role':'Админ проекта'},200)
    projects=call('GET','/api/projects?size=100')
    ids={item['id'] for item in projects['items']}
    assert created[0] in ids and created[1] in ids and created[2] not in ids
    assert projects['total']==2,projects['total']
    results.append({'case':'Список и счётчик проектов ограничены назначениями','total':2})
    call('GET',f'/api/projects/{created[2]}',expected=403)
    call('GET',f'/api/rag/chunks?projectKey={created[2]}',expected=403)
    results.append({'case':'Прямое чтение чужого проекта и RAG запрещено','status':403})
    call('PATCH',f'/api/projects/{created[1]}',{'retention':9},403)
    call('POST','/api/platform/users',{'email':'unused@example.test'},403)
    results.append({'case':'Админ проекта не меняет чужие настройки и системных пользователей','status':403})
    call('POST','/auth/switch-role',{'role':'Наблюдатель'},200)
    call('GET',f'/api/projects/{created[0]}')
    call('PATCH',f'/api/projects/{created[0]}',{'retention':9},403)
    results.append({'case':'Выбор наблюдателя ограничивает ранее доступную запись','status':403})
    call('POST','/auth/switch-role',{'role':'Главный админ'},200)
    call('GET',f'/api/projects/{created[2]}')
    results.append({'case':'Главный админ получает доступ ко всем проектам','status':200})
finally:
    fixtures=Path('.run/qa/access-project-fixtures.json')
    fixtures.parent.mkdir(parents=True,exist_ok=True)
    previous=json.loads(fixtures.read_text()) if fixtures.exists() else []
    fixtures.write_text(json.dumps(previous+created))
    call('POST','/auth/switch-role',{'role':'Главный админ'},200)
    for project in reversed(created):
        call('DELETE','/api/projects/'+project)
    Path('.run/access-smoke-projects.json').unlink(missing_ok=True)
Path('.run/access-smoke.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False,indent=2))
