# Design

## Context

См. proposal.md. Общего свободного settings JSONB нет: maintenance_settings имеет собственный строгий backup-контракт. Text RAG уже хранит квитанции и CAS; GGUF owner вводит снимок политики на строке импорта. Catalog47 ограничивает selection/evidence, RAG text1 — content/path; эти SQL уже приняты и остаются неизменными.

## Goals / Non-Goals

**Goals:** единый источник действующей политики, администрирование с CAS/квитанцией и исполнение text/GGUF без перезапуска.

**Non-Goals:** замена существующих ledger токенов, квот RAG, model rate limits и обслуживания; превращение всех внутренних защитных констант в произвольные числа; новый context aggregator.

## Decisions

- Catalog49 создаёт singleton runtime_limit_settings и immutable request receipts; запись использует advisory lock, fresh account FOR SHARE, CAS и security audit в одной транзакции. Переиспользовать maintenance.policy отклонено из-за несовместимых владельцев.
- GET /api/runtime-limits возвращает revision/policy/ceilings; admin GET/PATCH и own receipt доступны только browser MainAdmin; /internal/runtime-limits требует внутренний token.
- Новый флаг runtime_limit_configuration закрывает новые сохранения, сохраняет чтение и exact replay. Применение уже сохранённой политики не исчезает при выключении её редактора.
- Shared normalizers получают optional flat policy. Canonical hash использует только прежние исходные поля и технические границы, поэтому уменьшение текущего лимита не блокирует recovery. Новая квитанция содержит admission revision/limits; старые без admission совместимы.
- RAG получает новый снимок только для новых upload/search; callback перед мутацией подтверждает тот же revision/policy. Поиск возвращает admission snapshot, принятый chat context хранит его с цитатами.
- Additive RAG migration расширяет path до2048. Content остаётся128KiB: PostgreSQL ограничивает один tsvector1MiB, а безопасное увеличение файла требует отдельного chunked index. Catalog49 расширяет selection до131072/evidence2MiB. Старые SQL/checksums не меняются, текущий physical contract отражает новую схему.
- Text технические максимумы:256 документов,128KiB/файл,8MiB/пакет с путями,2048байт/путь,16384байт/query,32источника,16384байт/excerpt. Разрешённый текст исключает C0 controls кроме TAB/LF/CR: JSON максимум2×; пакет с envelope помещается в20MiB RAG parser. Query может расшириться6× и помещается в131072 selection. Сумма цитат с escaping помещается в2MiB history и8MiB RPC response.

## Risks / Trade-offs

- [Настройки изменились между чтением и мутацией] → snapshot revision проверяется свежим callback; конфликт требует повторной подготовки.
- [Конфигурация недоступна] → новые операции отказывают явно; сохранённые квитанции читаются без нового admission.
- [Принятые большие источники после снижения лимита] → проверки истории используют технические границы и принятый снимок, текущая политика не обрезает историю.
- [Незавершённые остальные лимиты] → inventory с конкретными владельцами и pending tasks, без объявления полного покрытия приложения.

## Migration Plan

Применить GGUF48, затем Catalog49 и additive RAG migration. Не откатывать старый бинарник поверх новых schema checksums; откат кода с сохранением принятой истории выполняется совместимым patch. Реальные PG, HTTP и UI доказательства собираются отдельно на Root-owned стенде.
