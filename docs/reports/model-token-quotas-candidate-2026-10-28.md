# Кандидат персональных квот токенов — 28 октября 2026

Отдельный срез от main `3f8c2ef3`, feature `user_model_token_quotas` по умолчанию OFF. Квота принадлежит пользователю платформы и canonical model ID, суммирует проекты/агентов этой модели. Первый поддержанный контракт — managed server text OpenAI/Ollama; native daemon, vision, embeddings, async device и прямой локальный BYOK не объявляются принятыми.

## Реализация

- Добавочная миграция46 после неизменённых0–45: policy/immutable configuration receipts и quota metadata прежнего `model_usage_calls`, без второго paid-attempt ledger.
- Атомарный допуск по actual + active reserve + unknown hold + оценке нового вызова. Резерв связан с прежним UUID и worker; unknown COMMIT не создаёт новую попытку.
- Полный reported actual не обрезается. Превышение последним ответом видно и блокирует следующий вызов; неполный/неизвестный результат удерживает бюджет, settlement не повторяет inference.
- MainAdmin UI в подробностях модели: пользователь без usage, собственный период, CAS, точный сохранённый intent до PUT, receipt recovery и явный повтор. OFF сохраняет настройку, историю и восстановление.

## Проверки чистого извлечения

| Область | Результат | Граница |
| --- | --- | --- |
| Quota UI и пять потребителей ModelDetails | 129/129, 0 skip/TODO | React/controller/API fixtures; реальный desktop/Gateway отдельно |
| Quota/admission/usage/rate unit | 90/90, 0 skip/TODO | Без PG и реального провайдера |
| Ollama payload, remote validation/secret unit | 87/87, 0 skip/TODO | Mock fetch/чистые функции; native daemon и HTTP client suite не запускались |
| Feature policy | 109/109 | ComputerSetup исключён, quota defaultOFF и OFF recovery проверены |
| OpenAPI | 27/27 | Базовый scanner, 309 routes/379 operations; две quota routes/три operations имеют browser/MainAdmin/receipt контракт |
| Frozen migration contract | 6 выбранных PASS | 77 PG cases отфильтрованы/не запускались. Это не приёмка PostgreSQL |
| Migration runner unit | 8/8 | Моки SQL runner, не реальный PG |
| Frontend/Catalog production TypeScript | PASS | Без выпуска или перезапуска работающих сервисов |
| OpenSpec strict | PASS | Change остаётся незавершённым: UI/PG/runtime gates отдельно |

Существующие literal migration checksums сохранены; изменены только ожидания нового хвоста46, pending arrays и marker следующей миграции в смежных тестах. Старые0–45 SQL не редактировались. Reset — отдельный WIP с будущим номером47 и требованиями сохранения действующих quota holds/receipts.

Сырые результаты и exact argv/PID/hash receipts находятся в `.run/quota-candidate-20261028/`. Исходный OpenAPI RED23/27 сохранён: устаревшие baseline expectations и неподходящая shallow-link топология QA зависимостей. Full cached Gateway dependency link восстановил предусмотренную compiler realpath boundary; генератор не менялся. Expectation fixes сверены с текущими controller/types: inventory, отдельный learning-quirks route и текущие remote options. Ни ComputerSetup, ни generic bare-controller scanner, ни reset в diff не включены.

Ранее в другом worktree сохранены quota SQL21/21 и HTTP7/7, включая causal RED→GREEN OFF→ON. Перед извлечением их31/31 и49/49 pinned source inputs совпадали с WIP. Они служат отдельной историей проверки; результаты этого чистого кандидата и runtime-приёмка не подменяются прежним запуском.

## Следующие ворота

- Изолированная сборка только Catalog и новая собственная UI → Gateway → Catalog → PG приёмка с actual reserve/overrun/следующим отказом, OFF recovery и reload.
- Политика двум вкладкам, потеря ACK после реального принятия, current MainAdmin/role privacy и устойчивое восстановление через UI.
- Текущий кандидат не запускает миграции рабочей БД, не меняет установленный мост и не включает контроль автоматически. Глобальный флаг, unsupported409 и полная работа всех managed каналов — разные свидетельства.
- Сборка, независимое review, новый PG/HTTP, браузер, CI и production не считаются подтверждёнными строками этого unit-отчёта. Их результаты добавляются после фактической проверки.

## Продолжение независимого ревью: physical dispatch fence

Два P1 подтверждены на production-байтах `2ae0a38a`: policy, включённая после второго async callback, пропускала physical send; уже физический OFF-вызов с незафиксированным optional progress не блокировал новый ON send. Корректный causal HTTP RED:8PASS/2FAIL, в обоих случаях фактический201 вместо503/409, без timeout. Сырой первый запуск с ошибкой helper сохранён отдельно и причинным RED2 не считается; его собственный контейнер также удалён.

Исправление сохраняет один ledger: новый managed server-text receipt начинает с durable dispatch_count0; последний owned SQL claim после всех async callbacks проверяет политику и фиксирует possible-send intent1 до action, включая OFF. В OFF без reservation policy не читается. Legacy NULL означает неизвестность; optional progress не может быть доказательством no-send. SQL-lock не переносится в сеть. Доказанно не вошедший в action процесс может завершить учёт нулём; неопределённая отправка не получает автоматический refund.

Связанный обход через длительность периода воспроизведён в том же десятислучайном HTTP-наборе: во время held physical provider policy меняется через actual API на1мс, ON-вызов всё равно обязан блокироваться. Causal9PASS/1FAIL сохранён; unpriced receipts теперь не исчезают только по времени. После settlement и возврата периода реальный actual7000/overrun2000 сохраняется.

На финальных source-байтах **40/40 PASS,0skip**: HTTP10 + PostgreSQL21 + admission9. Включены здоровая конкуренция за последний остаток, late settlement/COMMIT uncertainty, OFF под эксклюзивной блокировкой policy-таблицы и recovery. Оба собственных корректных RED/GREEN lifecycle завершились с отсутствующей группой, удалёнными fixture DB/контейнером/private profile; перед остановкой0 соединений. Source4355hashes не менялись во время каждой фазы. Сырые результаты: `.run/quota-p1-20261028/{owned-pg-retry1,owned-pg-period}/`.

Прежние dist/receipt `2ae0a38a` сохранены в `.run/quota-p1-20261028/retained-2ae-*`. Новый backend unit batch:91/91; TypeScript и новая Catalog build получают собственные квитанции после этого исправления. Эта PG/HTTP-приёмка не заменяет ожидаемый реальный desktop/Gateway проход и77 остальных отфильтрованных catalog migration cases.
