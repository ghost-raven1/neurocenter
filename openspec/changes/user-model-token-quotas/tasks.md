# Tasks

## 1. Согласованный контракт и запуск реализации

- [x] 1.1 Проследить usage/admission, trusted actor, physical dispatch и SQL owners; проверка: source-contract.md и ledger-seams-review.md с точными путями/строками.
- [x] 1.2 Внести подтверждённую семантику actual+estimate reserve, видимого last-call overrun и единственного usage ledger во все четыре planning artifacts; проверка: отсутствие hard-cap prerequisite и унаследованного rate-period ограничения.
- [x] 1.3 Получить root codegate и ownership общего usage/admission/transport, DI/флага/OpenAPI и свободной миграции; проверка: implementation-plan.md, root registration46 после неизменённых0–45; незарегистрированный reset WIP переносится на47 при отдельной интеграции.
- [x] 1.4 Проверить coherence/strict validate существующего change; проверка: сохранённые CLI root/status/validate receipts, без заявлений готовой реализации.

## 2. Политика и собственный токенный период

- [ ] 2.1 Добавить policy, exact policy-write receipts и additive quota metadata существующего usage; проверка: schema verifier + own isolated PG migration/rollback, прежняя история не переписана, период больше суток сохраняется, safe duration arithmetic проверена.
- [ ] 2.2 Добавить MainAdmin read/CAS-write/request-receipt API для canonical model+target user; проверка: unit/HTTP fixture actor/model identity, current rights, conflict, lost ACK/exact replay и404 unknown, без main DB/model вызовов.

## 3. Один usage owner и физический admission

- [ ] 3.1 Передавать существующий usage UUID к physical admission и атомарно check+reserve оценку; проверка: RED→GREEN для последнего остатка двух worker, repeated beforeDispatch не создаёт второй reserve, stale policy/rights/cancel/unknown COMMIT не отправляют лишний вызов.
- [ ] 3.2 Расширить settlement/reconciliation того же receipt; проверка: known actual меньше/больше резерва, visible overrun и следующий отказ, partial/unknown usage, late ACK, duplicate settlement, pre/post-dispatch cancel и lease expiry без falsezero/refund/повторного inference; ledger locks не ломают metadata isolation.
- [ ] 3.3 Подключить первую сквозную server-text вертикаль remote OpenAI/Ollama и managed Ollama с версионированной estimate; проверка: controlled HTTP показывает reserve до fetch, отсутствие output cap не блокирует модель, фактическое превышение сохраняется, каждый explicit physical retry имеет отдельную связанную identity.
- [ ] 3.4 Подключить оставшиеся managed поверхности до объявления их coverage, включая асинхронный device late receipt; проверка: связь с тем же usage UUID, private result/ACK/cancel invariants и честные partial/unknown counters. Непокрытая поверхность явно не заявляется ограниченной.

## 4. Понятная настройка и результат в UI

- [x] 4.1 Добавить отдельную feature модели с MainAdmin user selector/периодом и exact durable policy intent; проверка: component/hook cases пользователя без usage, CAS/two tabs, auth/model/user switch, сохранённый ввод и OFF read/history/recovery.
- [ ] 4.2 Показать actual, active reserve, unknown estimate и overrun с продолжением после отказа; проверка: controlled desktop1440×1000 для rejected admission, last-call overrun, lost ACK/exact replay и отсутствующего cap, без платных/рабочих данных; инструкция согласована с фактическим coverage.

## 5. Приёмка связного среза

- [ ] 5.1 Выполнить затронутые typecheck/targeted integration/strict validation и независимое review; проверка: exact commands/source hashes, own PG/browser cleanup, PASS/SKIP/непроверенные каналы раздельно, root разрешает включение флага только после этого.
