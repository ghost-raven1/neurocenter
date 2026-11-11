---
type: epic
title: "Каталог: системные ассеты и внешние репозитории"
parent: initiative-architecture
covers: [R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md]
after: []
refined: false
risk: medium
---

# Каталог: системные ассеты и внешние репозитории

## Description

Расширение каталога по решению пользователя 2026-11-10. Две линии, исполняются параллельно с остатком эпика 2 (директива пользователя 2026-11-10: «делай параллельно с задачами эпика»).

**Линия 1 — системные ассеты явным образом (entry 12.1).** В каталоге 34 ассета; пользовательская формулировка критерия: «посмотри какие влияют на работоспособность системы и отдельных подсистем» — т.е. выделение по функциональной нагрузке (от чего реально зависит работа платформы и её подсистем), а не по префиксу имени. Результат анализа (основания в коде):

| Подсистема | Ассеты | Основание |
|---|---|---|
| Core (устройственный канал) | `neurocenter-bridge` | мост asset-sync: BRIDGE_CAPABILITIES, билеты, connect/verify — без него нет устройства |
| RAG / проектный контекст | `mcp-opencode-rag`, `plugin-opencode-rag-plugin` | prepared-source `RAG_PLUGIN_SOURCE` (shared/opencode-rag-source.cjs), rag-installation-authority: features `hosted-rag-core-v1`/`opencode-rag-ui-v1`, rag-ui-капабилити устройства (frontend ragUiState) |
| Системные роли (FR-303) | `skill-neurocenter-project-context`, `skill-neurocenter-system-assistance`, `skill-neurocenter-project-learning` | контекст/опыт системных ролей (coordinator/packager/indexer/ai-admin/autoconfigurator — system-role.definitions.ts) |
| Упаковка ассетов | `skill-neurocenter-packaging` | регламент упаковки в каталог (packager-роль) |
| Агент-команда (дефолт) | `agent-planner`, `agent-developer`, `agent-reviewer`, `agent-tester`, `agent-documenter` | дефолтный состав команды проекта (FR-301); метка = «нужен для стандартной работы», замена на пользовательских агентов разрешена. **Решение 2026-11-10: агенты по умолчанию = САМЫЕ ПРОДВИНУТЫЕ** (не минимальные промпты — текущее состояние: 4-5 строк промпта + permission-профиль) и **должны иметь способность и инструменты для анализа И решения задач/проблем** (матрица: анализ — чтение/поиск/RAG/веб/диагностика; решение — edit/bash/task/skills/MCP); фоновое исследование запущено 2026-11-10 (с требованием об инструментах анализа/решения), результат — отдельная работа по улучшению агент-промптов (scope: epic-agent-team / каталог) |

Итого 12 ассетов системной группы; остальные 22 (включая модель-ассеты — см. решение (в)) — не required.

**Решения пользователя 2026-11-10 (зафиксированы):** (а) системные ассеты = **обязательная установка на компьютер (устройстве)** — onboarding/реконсилиация ставит required-набор автоматически, отсутствие = явное «устройство не готово»; (б) системные ассеты = **по умолчанию в проект** — при создании проекта required-набор автоматически входит в назначения; снятие системного ассета из проекта недоступно (UI: без кнопки; API: явная ошибка с причиной); (в) **модели временно из поставки** — дефолтные модели всех подсистем (чат, vision, embedding) и **ключи провайдеров берутся из конфигурации opencode на компьютере** (opencode.json + auth-хранилище); модель-ассеты каталога (model-embedding-qwen3-4b, model-vision-qwen3-vl-2b) остаются как **возможность хостинга** (установка по желанию, FR-601-механизм сохраняется), но в required-набор и project-дефолт не входят; (г) **если конфигов opencode нет — предлагать заполнить** (явный онбординг-шаг: что именно добавить), тихий fallback на каталог отсутствует. Механика `required: true` в карточке — часть entry 12.1.

Важно: внутренние системные агенты платформы (`agent-coordinator`, `agent-packager`, `agent-indexer`, `agent-ai-admin`, `agent-autoconfigurator`) — НЕ ассеты каталога (закрытые определения в system-role.definitions.ts + DB-ограничения); они не помечаются, но их зависимости от каталожных скиллов — основание меток.

**Линия 2 — пять внешних репозиториев «из коробки» (entries 12.2–12.6).** Пользователь: «нужно их полноценно перенести и запаковать чтобы все работало из коробки». Пinned-HEAD (git ls-remote, проверено 2026-11-10):

| Репо | HEAD | Форма | Что даёт |
|---|---|---|---|
| alfaoz/opencode-see-image | `091becb` (master) | opencode-плагин (v1+v2), npm `opencode-see-image` 1.5.0 | картинки для текстовых моделей: роутинг в vision-модель |
| nextlevelbuilder/ui-ux-pro-max-skill | `4f2dbb6` (main) | skill (+CLI, .claude-plugin) | дизайн-интеллект для UI/UX |
| bmad-code-org/BMAD-METHOD | main @ 11-08 | бандл 32 skills (skills/: bmad-*, bmod-*) | BMAD-метод (stable v6.12 / v7 alpha) |
| alibaba/open-code-review | main @ 11-10 | CLI (npm `@alibaba-group/open-code-review` + нативные биндинги `@alibaba-group/ocr-linux-x64` etc.) + Claude-plugin | AI code review на git-diff |
| Fission-AI/OpenSpec | main @ 11-09 | CLI (npm `@fission-ai/openspec` 1.17.0, bin `openspec`) + 12 skills (openspec-*) | Spec-driven development |

Формат венединга — прецедент `catalog-source/components/codex-connector` (in-tree source + SOURCE.json: repo/commit/license/scope/files+sha256) + metadata-карта по SHA256 + recipe + index/manifest + re-pin (`scripts/assets/catalog-source-pin.mjs --write`). Provenance (FR-201/203): SHA-опись, версия/SHA/источник/время/издатель в карточке. «Из коробки»: установленный ассет работает на устройстве без ручных шагов (рецепт установки + зависимости закрыты венедингом).

**Открытые решения** (зафиксированы в тикетах, решаются при исполнении): kind CLI-ассетов (новый kind `tool` vs обёртка skill+CLI); бандл vs отдельные скиллы для BMAD (32) и OpenSpec (12); uv/python-зависимость BMAD-setup как compatibility-метка; размер венда open-code-review (npm-tarball vs git-source).

**Линия 3 — robustness поставки (R9): self-heal asset-source blobs (entry 12.8).** Решение пользователя 2026-11-11 (после инцидента 503 на `install.sh`): **вариант 3 — self-heal на старте** catalog-service. Инцидент: после восстановления volume в `/app/runtime-artifacts/.asset-source-blobs/` отсутствовали blob-архивы bridge v0.9.17 (darwin `a22dcb33…` / linux `bc49be91…`) — строки в `asset_source_blobs` были, файлов на диске нет → `/internal/asset-sources/bridge` и `install.sh` отдавали 503, пока blobs не восстановили вручную (`docker cp`). R9: при старте catalog-service (и/или по первому asset-sources-запросу) сверить таблицу `asset_source_blobs` с каталогом `.asset-source-blobs/`: для каждого зарегистрированного blob (sha256) проверить наличие файла и совпадение sha256; при отсутствии/несовпадении — восстановить из URL receipt'а (`asset_source_receipts` / `bridge_source_settings`) с sha256-проверкой; при retired/недоступном источнике — явное состояние (лог + health), не тихий сбой. Идемпотентно, безопасно для параллельного старта, bounded (не перекачивать intact-blobs).

## Outcome

Для пользователя: в каталоге явная группа «Системные» (данные + UI) с пониманием, что нельзя отключать без потери работоспособности подсистем; пять внешних инструментов (see-image, ui-ux-pro-max, BMAD, open-code-review, OpenSpec) ставятся из каталога и работают из коробки на dev-стеке и устройстве.

## Done when

1. Required-набор системных ассетов (14): метка system+required+subsystem в карточках; index/manifest несут поля; API отдаёт; UI — отдельная группа «Системные (обязательные)» + badge, снятие недоступно; устройство без required-набора = явное «не готово»; новый проект = required-набор в назначениях автоматически (тесты).
2. Пять ассетов в каталоге: component (source+SOURCE.json, pinned commit) + metadata-карта (провенанс FR-203) + recipe; установка «из коробки» на dev-стек/чистое устройство проверена (тест/скрипт).
3. Re-pin каталога (pin-каскад: producer.json → manifest.json → bundled-catalog.lock.json) + drift-тесты каталога зелёные; корневой сьют без деградации.

## Boundaries

- Версионирование/публикация каталога как механизм (immutable-версии, retire, провенанс) — эпик 2 (этой линейкой уже пользуются).
- Канал доставки на устройство (мcp-host, билеты) — эпик 2; установщики — эпик 7.
- Использование BMAD/OpenSpec агент-командой (FR-308) — эпик 9; этот эпик делает инструменты доступными в каталоге.
- litellm-agent-control-plane (MCP-прокси/креды) — кандидаты A/B/C ждут решения пользователя, в этот эпик не входят.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirement R12)
- PRD — _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (FR-201..203, FR-301, FR-303, FR-308, FR-606)
- catalog-source — manifest.json (34 ассета), components/ (прецеденты codex-connector/fetch-mcp/python-context), metadata/, recipes/, producer.json
- scripts — catalog-source-pin.mjs (--write), catalog-plugins/prepare.mjs (index)

## Notes

- Параллельно с 2.7/2.10/2.13 (каталог-данные не пересекаются с кодом 2.7/2.10); re-pin (12.7) — после их мержа, чтобы pin-каскад не конфликтовал.
- Pinned-HEAD зафиксирован на 2026-11-10; при исполнении сверить ls-remote (дрейф = новый pin + заметка).
