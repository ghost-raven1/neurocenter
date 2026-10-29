# Tasks

## 1. Предложения обновления

- [x] 1.1 Добавить точное сравнение catalog head, project pin и квитанции выбранной папки для MCP/плагинов/агентов; проверить wrong binding, unknown read и numeric downgrade отдельными тестами.
- [x] 1.2 Добавить компактные сводки и scoped фильтры на Ant Design с существующими explicit actions; проверить реальный рендер, pending removal, read-only, OFF, смену контекста и конфликт, описать фактические границы приёмки.

## 2. Текущий RAG runtime

- [x] 2.1 Закрепить реальные npm/Git bytes OpenCodeRAG2.12.2, только достижимые новые зависимости и полную source closure; проверить locked integrity, exact patch contracts и source snapshot round-trip.
- [x] 2.2 Обновить guards live config/embedder/store и обе ветки promotion/lock cleanup; проверить helper/hosted/profile/UI unit contracts и недопущение неполного индекса.
- [x] 2.3 Проверять весь Quirk JSONL до native reconcile/изменений, сохранив old source marker и валидные tombstones; проверить corrupt late line, invalid UTF-8, ссылки, duplicate, неизменность bytes и отсутствие импорта tombstone как опыта.
- [x] 2.4 Собрать собственные host MCP/plugin runtimes и пройти actual pinned OpenCode1.14.48, MCP, Web UI, live config, partial failure, сохранность JSON/индекса и corrupt Quirk no-mutation; сохранить evidence и обновить описание точной версии/непроверенных платформ.

## 3. Current-only source supply

- [ ] 3.1 Включить проверенные current metadata, inline agents/skills и необходимые recipe/source/locks в основной Git; проверить exact SHA, stable IDs, отсутствие old runtime archives и source provenance без выдуманного Git commit.
- [ ] 3.2 Перевести CLI/Catalog на bundled current metadata/source с точными local aliases старых receipts; проверить собственный cold checkout при запрете старого repo/GH Releases, отсутствие model-weight downloads и понятный optional deferred status.
- [ ] 3.3 Пройти собственный импорт/публикацию/проект/bridge для новой текущей поставки с прежними pins/custom card/queued job; проверить CAS, отмену, повтор, revoke/lost ACK и сохранение generation, документировать работающий git update workflow.

## 4. Интеграция

- [ ] 4.1 Выполнить независимое review, affected TypeScript/сборки, strict OpenSpec validation и desktop proposals→explicit update→receipt; разделить unit/native/browser/CI/deployment свидетельства.
- [ ] 4.2 Передать Root exact file manifest и результаты, обновить бэклог после реализации; только Root интегрирует готовые feature-коммиты и отдельно проверяет main/runtime/CI.

## Workflow follow-up

- После фактического завершения всех задач синхронизировать specs и архивировать изменение.
- Удаление прежнего asset-репозитория выполняет только Root после проверенной независимости поставки и отдельного технического auth gate.

Промежуточные свидетельства реализации и unit-проверок: `docs/reports/catalog-updates-rag-2026-10-29.md`. Native, desktop, full source migration и работающая площадка остаются открытыми задачами.
