# Проверка изоляции двух тестовых PostgreSQL-баз и восстановления копии в отдельную временную БД.
import hashlib
import http.cookiejar
import json
from pathlib import Path
import subprocess
import urllib.error
import urllib.request
import uuid

base='http://localhost:5173'
client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
client.addheaders=[('Accept','text/html,application/json')]
created=[]
fixtures=[]
report=[]
restored='nc_verify_'+uuid.uuid4().hex

def call(method,path,body=None,binary=False):
    request=urllib.request.Request(base+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','X-Neurocenter-Request':'1'})
    with client.open(request,timeout=60) as response:
        raw=response.read()
        return raw if binary else json.loads(raw)

def sql(database,query):
    result=subprocess.run(['docker','compose','exec','-T','postgres','psql','-U','rag','-d',database,'-v','ON_ERROR_STOP=1','-At','-c',query],capture_output=True,check=True)
    return result.stdout.decode().strip()

client.open(base+'/auth/login',timeout=30).read()
try:
    for label in ['А','Б']:
        project=call('POST','/api/projects',{'name':'Проверка изоляции '+label+' '+uuid.uuid4().hex[:8]})
        created.append(project['id'])
        database='nc_rag_'+hashlib.sha256(project['id'].encode()).hexdigest()[:32]
        fixtures.append({'id':project['id'],'database':database})
        tracker=Path('.run/project-db-fixtures.json')
        tracked=json.loads(tracker.read_text()) if tracker.exists() else []
        tracker.write_text(json.dumps(tracked+[fixtures[-1]]))
        content='Уникальное содержимое проекта '+label
        call('POST','/api/rag/sync',{'projectKey':project['id'],'chunks':[{'id':'same-chunk-id','filePath':'README.md','content':content,'contentHash':'server-recalculates'}]})
    values=[]
    for fixture in fixtures:
        response=call('GET','/api/rag/chunks?projectKey='+fixture['id'])
        assert response['count']==1,response
        values.append(response['chunks'][0]['content'])
        info=call('GET','/api/rag/database?projectKey='+fixture['id'])
        assert info['databaseName']==fixture['database'],info
    assert values[0]!=values[1],values
    report.append('Одинаковый ID фрагмента в двух разных БД не смешивает данные проектов')
    backup=call('POST','/api/projects/'+created[0]+'/backups')
    dump=call('GET','/api/projects/'+created[0]+'/backups/'+backup['id']+'/download',binary=True)
    assert dump.startswith(b'PGDMP') and len(dump)==backup['sizeBytes']
    assert len(call('GET','/api/projects/'+created[0]+'/backups'))==1
    try:
        call('GET','/api/projects/'+created[1]+'/backups/'+backup['id']+'/download',binary=True)
        raise AssertionError('Чужая проектная копия доступна по другому URL')
    except urllib.error.HTTPError as error:
        assert error.code==404,error.code
    report.append('Копия скачивается целиком и не выдаётся через URL другого проекта')
    sql('postgres','CREATE DATABASE "'+restored+'"')
    subprocess.run(['docker','compose','exec','-T','postgres','pg_restore','-U','rag','-d',restored,'--no-owner'],input=dump,capture_output=True,check=True)
    assert sql(restored,'SELECT content FROM rag_chunks')==values[0]
    assert sql(restored,'SELECT count(*) FROM rag_chunks')=='1'
    report.append('Реальный pg_dump восстановлен в изолированную временную БД; содержимое совпало')
    Path('.run/project-databases-smoke.json').write_text(json.dumps({'ok':True,'scenarios':report,'backupBytes':len(dump)},ensure_ascii=False,indent=2))
    print(json.dumps({'ok':True,'scenarios':len(report),'backupBytes':len(dump)},ensure_ascii=False))
finally:
    sql('postgres','DROP DATABASE IF EXISTS "'+restored+'"')
    for project in reversed(created):
        call('DELETE','/api/projects/'+project)
    # Только эти тестовые БД удаляются после штатной остановки сервиса, чтобы не обрывать его пулы.
