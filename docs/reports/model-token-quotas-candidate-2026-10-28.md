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
