# Backend текстовой базы знаний — 29 октября 2026

Проект получил отдельный текстовый корпус и поиск цитат на существующем PostgreSQL. Флаг `project_text_knowledge` включён по умолчанию и не зависит от `model_hosting`; семантический `project_search` сохраняет прежний контракт. Текстовые операции не требуют embedding-модели, OpenCode-плагина, LanceDB или новых runtime-пакетов.

## Контракт

| Операция | Путь после `/api/projects/:id/knowledge` |
| --- | --- |
| Состояние корпуса | `GET /text` |
| Добавление/обновление документов | `POST /text/documents` |
| Восстановление квитанции | `GET /text/requests/:key` |
| Поиск источников | `POST /text/search` |

Запись принимает UUID `requestKey`, `expectedRevision` и `documents:[{path,content}]`; повтор восстанавливает тот же результат, изменение тела с тем же ключом отклоняется. Batch: до 16 UTF-8 файлов, 128 KiB на файл и 512 KiB суммарно. Поиск принимает `query` и необязательную ревизию; выдаёт не более шести источников с путём, строками, excerpt и точными revision/corpusHash.

Catalog проверяет свежие права пользователя и проекта, RAG — атомарность корпуса, квитанций и общего бюджета с семантическими данными. Добавлены Catalog migration47 и отдельная RAG `project-text-1`; прежние SQL-миграции и их checksums не изменены. Текстовый upsert не удаляет семантические строки, поколения, профиль или seal.

Явная selection `{mode:'text',revision,corpusHash,query}` включается в идентичность model-chat запроса. До provider dispatch повторно проверяются права и corpus pin; принятые источники сохраняются в отдельной приватной таблице. Feature OFF сохраняет чтение состояния и собственных принятых квитанций.

## Проверки

- Catalog: 152 целевых unit/regression, 14 migration unit и 35 shared/OpenAPI проверок — PASS. 79 исторических Catalog PG-тестов в этом запуске не выполнялись; они не считаются пройденными.
- Собственный PostgreSQL Catalog: 13/13 — PASS, включая additive47/physical schema, lost ACK, OFF, отзыв прав, отмену и corpus change до provider dispatch.
- Три существующих ModelRuntime-маршрута проверены controlled provider ports: ollama, remote-openai и device-codex получают выбранные цитаты без embedding-вызовов. Это не настоящие внешние модели и не новая GGUF-поставка.
- RAG: 64 целевых unit/regression, затем 67 реальных PG + 2 offline inventory — PASS. PG: migrations33, text corpus13, generations19, search4; проверены quota/concurrency/rollback/TRUNCATE recount и неизменность семантических границ.
- TypeScript production и новых тестов — PASS; Root дополнительно выполнила официальные сборки Catalog/RAG/Gateway совместно с текущими core/vendor-изменениями.
- Независимый source/evidence review: 42 исходных пути, совпадение SHA, отсутствие зависимости от незавершённого frontend — CLEAR.

Локальные Catalog-свидетельства: `.run/project-text-knowledge-20261029/source-manifest.json`, `catalog-verification-receipt.json`, timestamped `catalog-pg-2026-10-29T08-07-05.837Z.*`. RAG-свидетельства: private `/tmp/nc-text-pg-retry1-{migrations-final-lUPqeA,corpus-final-cpIdur,generations-HtI0VA,search-576wVi}`. Собственные тестовые базы и sessions закрыты; рабочая база Main не менялась.

## Открытые границы

Frontend загрузки/поиска и публичная Gateway→Catalog→RAG HTTP-приёмка ещё не завершены. Общий агрегатор разрешённых чатов, правил/опыта Quirk и знаний для всех маршрутов модели — следующая работа. Shared project-chat text selection и содержимое approved rules системных ролей этим срезом не добавлены. Настоящий OpenCode/auth, внешние модели, установленный архив, CI и сервер пользователя не проверялись.

Ранний PG retry исчерпал маленький tmpfs тестового кластера; сохранён как инфраструктурный отказ, затем проверки повторены на отдельном большем стенде. Раннее свидетельство Catalog9 не используется вместо финального13: его raw был перезаписан неуспешной попыткой, что явно зафиксировано в финальной квитанции. Процент покрытия всего проекта из этих частных наборов не выводится.
