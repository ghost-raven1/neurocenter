# Design

## Context

См. proposal.md. ProjectAgentRepository уже даёт effective assignments и revision; configure-project-agents сохраняет desired manifest, approved compilation, mapping и результат установки. Приватный журнал моста подтверждает локальную квитанцию и SHA файлов. Method workflow уже управляет bounded runtime, отменой, измерением файлов и durable recovery.

## Goals / Non-Goals

**Goals:** один выбранный агент действительно исполняет полный цикл методики; его profile/model/target проверены и видны в результате.

**Non-Goals:** новый универсальный исполнитель, перенос всех project plugins в изолированные agent containers, автоматическая установка моделей, изменение прежних квитанций, захват всех файлов проекта при постановке в очередь, публикация сырых prompt/credentials в результат.

## Decisions

1. Расширить прежний protocol v1 optional `agent`, сохраняя байтовую нормализацию старых payload без поля. Для нового пути отдельные feature `project_agent_workflows` и capability `agent-method-selected-agent-v1`. Browser передаёт только agentId/expectedAgentsRevision внутри workflow.
2. Сервер строит snapshot из актуального desired agent set и последней успешной точной configure delivery. Snapshot хранит agentId/slug/version/agentsRevision, desired/compiled manifests, fileSha, configurationJobId, primary/all mode и approved safe model mapping. Свежие modelRequirements и результат compilation проверяются независимо. Новая таблица/очередь не нужна.
3. Мост читает bridge-private agents proof и текущий файл, namespace и model metadata без auth.json или inference. Owned HTTP server проверяет реально загруженного агента до model POST и получает явные agent/model. Subagent и наследуемая модель не получают молчаливого fallback.
4. Новый agent snapshot проходит проверки перед claim/authorize/успешной фиксацией; legacy accepted job не зависит от нового флага. Флаг ON требует явного выбора для новых UI-запусков. Старые API-клиенты сохраняют явный agentless protocol при включённой базовой функции в обоих состояниях нового флага; это не fallback выбранного агента. OFF сохраняет legacy generic admissions, но сохранённый выбранный агент не превращается в generic без явного действия пользователя.
5. Публичные job/result metadata содержат identity/hash исполнителя, без prompt, baseUrl или полного mapping. Exact request recovery сохраняет agent/revision, draft и прежний target. Существующие partial observation, cancel и receipt-before-ACK переиспользуются.

## Risks / Trade-offs

- Изменения назначения во время запуска → fresh authorization и matching model/delivery; успешный поздний результат не подтверждает другой профиль.
- Нативная конфигурация меняется вручную → проверка proof/file/namespace/model и owned runtime metadata, без скрытой перезаписи.
- Флаги выключены во время ожидания → новые действия запрещены, история и отмена сохраняются независимо от флага; ACL остаётся обязательным.
- Набор project assets общий для папки → UI и документация не обещают отдельную plugin sandbox каждого агента.

## Migration Plan

Аддитивный shared contract и новый выключенный флаг. Поставка требует соответствующих frontend/Catalog/flags/bridge. Старые payload без agent валидируются прежним способом; rollback выключает новые admissions и сохраняет историю/квитанции. Изолированные сборки не меняют установленный мост.
