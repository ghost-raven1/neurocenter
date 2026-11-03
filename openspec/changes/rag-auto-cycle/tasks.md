# Tasks

## 1. Флаг и чистая логика
- [x] 1.1 Добавить флаг `rag_auto_cycle` (group `knowledge`, dependsOn `rag_sync`, default on) в JSON-каталог и union; проверить feature-flags-service и flag-off путь (без таймеров, без запросов, побайтово прежний UI).
- [x] 1.2 Вынести чистый хелпер `ragAutoCycle.ts`: `ragAutoCycleDecision` (повтор только `applied` + локальный шаг `failed`/`cancelled`, лимит попыток, причины: flag-off/no-plan/not-applied/no-local-step/local-not-failed/at-cap/local-failed) + константы лимита и паузы.

## 2. Хук и интеграция
- [x] 2.1 Хук `useRagAutoCycle`: автоповтор локального шага через существующее действие `retryLocal` (то же, что ручная кнопка), пауза 10 с, лимит 3 на план, защита от дублирования запланированного повтора, owner-guard и сброс через `useProjectReindex` при смене проекта/аккаунта.
- [x] 2.2 Встроить статус в `ProjectReindexStatus` («Автоповтор подключения: N/3», «Автоматические повторы исчерпаны»), сохранив ручные кнопки; интеграция в `ProjectEmbedding` только через проп — flag-off без изменений.

## 3. Приёмка
- [x] 3.1 Пройти затронутые typecheck/scoped eslint, targeted-тесты ProjectEmbedding и feature-flags-service, независимое ревью, исправить подтверждённые дефекты, выполнить strict OpenSpec verification. Ревью: major M-1 (StrictMode double-mount расходывал слот лимита до первого fire — инкремент перенесён в callback таймера, отменённый таймер не расходует попытку; добавлен тест StrictMode) + minory: m-5 (UI показывает запланированный повтор как следующий слот N+1), m-4 (запись лимита ограничена актуальным планом). Принятое ограничение: m-1 (если retryLocal оказался no-op из-за кратковременной блокировки useProjectReindex, слот считается — окно ничтожно мало против 10-с паузы, ручной повтор всегда доступен). Проверено: targeted 29/29 (ProjectEmbedding), feature-flags-service 8/8, tsc 0, scoped eslint 0 (без warnings), независимое ревью.
