---
title: 'Q9: Colibri spike — GO/NO-GO по frontier-MoE как второму inference-бэкенду'
type: 'feature'
ticket: '15'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/.memlog.md
  - _bmad-output/initiative-architecture/initiative-architecture.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Q9 (предложение пользователя 2026-11-05, PRD:209, initiative:99, .memlog.md:38-39): **Colibri** (github.com/JustVugg/colibri, Apache-2.0, v2.1.0, 47.9k stars) — иерархический inference-движок **frontier MoE-моделей** (горячие эксперты на GPU CUDA/Vulkan, тёплые в RAM, холодные стримятся с NVMe; чистый C; OpenAI/Anthropic-совместимые API; GGUF читает как есть; `--model-dir` — без авто-загрузки). Роль = **кандидат на ВТОРОЙ локальный inference-runtime** (наряду с Ollama), НЕ замена Ollama. Закрывает класс, недоступный Ollama-runtime (FR-602): **модели 100B–1T на NVMe** (hierarchical expert-offloading). Вписывается в FR-601 (GGUF+SHA, веса вручную, --model-dir без авто-загрузки). Взаимодействие с M-6/AD-D2 (write-owner model-weights, dual-writer в compose.production.yml): colibri — **кандидат на путь GGUF**. Сейчас решения НЕТ: неизвестно, примет ли пилот colibri как второй бэкенд. Gate для моделей-историй epic-project.

**Approach:** **Spike (research, hitl=false):** прогнать **1–2 frontier-MoE модели** на **аппаратной пилота** через colibri (OpenAI-совместимый API в compose), **замерить против Ollama** (latency/throughput/VRAM/RAM/диск/NVMe-стриминг), и вынести **вердикт GO/NO-GO**: принять как второй бэкенд / параллельно / отклонить. Вердикт → architectural-решение в data-spine (AD-D2, write-owner model-weights, GGUF-путь). **НЕ production-код** — только spike-стенд (compose-сервис colibri, OpenAI API) + отчёт-вердикт. Unknown (явные): аппаратная пилот-хоста (RAM/NVMe/GPU) — spike измеряет на реальном железе.

## Boundaries & Constraints

**Always:**
- Spike = research (hitl=false): стенд + измерения + вердикт, НЕ production-код.
- 1–2 frontier-MoE модели на аппаратной пилота (GGUF, --model-dir, без авто-загрузки — FR-601).
- OpenAI-совместимый API colibri в compose (сравнимый с Ollama).
- Замер против Ollama: latency/throughput/VRAM/RAM/диск/NVMe-стриминг (одинаковые модели/запросы).
- EXIT-CRITERION = вердикт **GO/NO-GO** (принять / параллельно / отклонить) + рекомендации по AD-D2 (write-owner model-weights, GGUF-путь).
- Закрытый контур (self-hosted, Apache-2.0, локально) — нет конфликта (PO-оценка .memlog.md:38).
- Вердикт задокументирован в _bmad-output (влияние на AD-D2).

**Never:**
- Не писать production-код (spike изолирован — только compose-стенд + отчёт).
- Не менять Ollama-runtime (FR-602) — colibri = второй бэкенд, не замена.
- Не нарушать закрытый контур (self-hosted, локально, без внешних авто-загрузок).
- Не принимать решение без измерений (verdict = на данных, не предположении).
- Не подменять AD-D2 (write-owner model-weights) — вердикт ВЛИЯЕТ на AD-D2, не меняет его в обход.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Spike-стенд | 1–2 frontier-MoE (GGUF), colibri в compose, OpenAI API | Модель отвечает через OpenAI API |
| 2 | Замер vs Ollama | одинаковые модели/запросы (colibri vs Ollama) | latency/throughput/VRAM/RAM/диск/NVMe-стриминг зафиксированы |
| 3 | Вердикт GO | colibri ≥ Ollama на frontier-MoE (100B–1T NVMe) | GO: принять как второй бэкенд |
| 4 | Вердикт параллельно | colibri для frontier-MoE, Ollama для остальных | PARALLEL: два бэкенда (по классу моделей) |
| 5 | Вердикт NO-GO | colibri < Ollama / неустойчиво / железо не тянет | NO-GO: отклонить (Ollama остаётся) |
| 6 | Аппаратная пилота | реальное железо (RAM/NVMe/GPU) | Замер на реале (unknown закрыт) |
| 7 | Влияние на AD-D2 | вердикт | Рекомендация по write-owner model-weights (GGUF-путь) |
| 8 | Production-код | — | НЕ изменён (spike изолирован) |
| 9 | Закрытый контур | self-hosted, локально | Без внешних авто-загрузок (FR-601) |

</frozen-after-approval>

## Code Map

- `_bmad-output/initiative-architecture/.memlog.md:38-39` — colibri-детали (JustVugg/colibri, Apache-2.0, v2.1.0; hierarchical frontier-MoE; OpenAI/Anthropic API; GGUF as-is; --model-dir; роль = второй runtime; M-6/AD-D2 GGUF-путь; spike-критерии).
- `_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md:209` — Q9 (colibri как второй локальный inference-runtime для frontier MoE; spike в epic-project); `:136` FR-601 (GGUF/архив, SHA, веса вручную); `:137` FR-602 (Ollama-runtime lifecycle).
- `_bmad-output/initiative-architecture/initiative-architecture.md:99` — Q9 (ассоциация с epic-project, gate для моделей-историй).
- `deploy/production/environment-model.json` — compose-модель (12 сервисов) — spike-сервис colibri (если появится) → environment-model + drift-тесты + compose-заголовок (pattern 1.12 D2).
- `compose.production.yml` — AD-D2 dual-writer (M-6) — влияние вердикта (GGUF-путь).
- `services/catalog-service/src/models/gguf-runtime.service.ts` — Ollama-runtime (prepare blob→create) — REFERENCE для сравнения.
- `services/catalog-service/src/models/hosting.service.ts` — Ollama hosting (start/stop/check) — REFERENCE.
- Spike-стенд (new, изолирован): `scripts/spike/colibri/` (compose-сервис colibri + OpenAI API + benchmark-скрипт) — НЕ в production-пути.

## Tasks & Acceptance

### Execution
- [ ] Spike-стенд: compose-сервис colibri (OpenAI-совместимый API, --model-dir, GGUF as-is, без авто-загрузки) + 1–2 frontier-MoE модели (GGUF) на аппаратной пилота.
- [ ] Benchmark-скрипт: одинаковые модели/запросы через colibri (OpenAI API) и Ollama — замер latency/throughput/VRAM/RAM/диск/NVMe-стриминг.
- [ ] Замер на реальном железе пилота (RAM/NVMe/GPU — unknown закрыт).
- [ ] Отчёт-вердикт: GO (принять как второй бэкенд) / PARALLEL (два бэкенда по классу) / NO-GO (отклонить) + данные + рекомендации по AD-D2 (write-owner model-weights, GGUF-путь).
- [ ] Документация вердикта в _bmad-output (влияние на AD-D2, architectural-решение data-spine).
- [ ] Если spike-сервис colibri остаётся в compose → environment-model.json + drift-тесты + compose-заголовок (pattern 1.12 D2).

### Acceptance
- **Given** spike-стенд (colibri + 1–2 frontier-MoE, OpenAI API) **when** запуск **then** модели отвечают через OpenAI API.
- **Given** одинаковые модели/запросы (colibri vs Ollama) **when** замер **then** latency/throughput/VRAM/RAM/диск/NVMe-стриминг зафиксированы.
- **Given** данные **when** вердикт **then** GO/PARALLEL/NO-GO + рекомендации по AD-D2 (задокументировано).
- **Given** production-код **when** spike **then** НЕ изменён (spike изолирован).
- **Given** closed-contour **when** стенд **then** self-hosted, локально, без внешних авто-загрузок.

## Design Notes

- **Spike = решение, не код:** цель = вердикт GO/NO-GO (data-driven), не production-интеграция. Production-интеграция colibri (если GO) — отдельная история (после вердикта, по AD-D2). Здесь только стенд + измерения + вердикт.
- **Второй бэкенд, не замена:** colibri = кандидат на ВТОРОЙ локальный runtime (наряду с Ollama). Ollama остаётся (FR-602). Colibri закрывает класс 100B–1T (NVMe-hierarchical), недоступный Ollama. PARALLEL-вердикт = два бэкенда по классу моделей.
- **M-6/AD-D2 (write-owner model-weights):** dual-writer в compose.production.yml (M-6) — не зафиксирован GGUF→ollama путь. Colibri = кандидат на GGUF-путь. Вердикт ВЛИЯЕТ на AD-D2 (write-owner), но не меняет в обход (architectural-решение data-spine).
- **Закрытый контур (нет конфликта):** self-hosted, Apache-2.0, локально, --model-dir без авто-загрузки (FR-601: веса вручную, SHA). PO-оценка (.memlog.md:38): конфликта с закрытым контуром нет.
- **Unknown = аппаратная пилота:** RAM/NVMe/GPU пилот-хоста неизвестны — spike измеряет на реале. Это ключевой unknown (hierarchical offloading зависит от NVMe/RAM).
- **Gate для моделей-историй:** Q9 = gate для моделей-историй epic-project (initiative:99). Вердикт влияет на FR-601/602 (GGUF-путь, runtime). Но spike НЕ блокирует остальные entry (after=[]) — вердикт = вводная, не предпосылка.
- **Сык с entry 3 (FR-601 GGUF-архив):** colibri читает GGUF as-is — совместимо с GGUF-импортом (entry 3). Вердикт PARALLEL/GO = colibri как runtime для импортированных GGUF.

## Verification

```bash
# Spike — не корневой сьют (изолирован). Замер на пилот-хосте (HITL-железо).
# compose-стенд colibri + OpenAI API + benchmark (latency/throughput/VRAM/RAM/NVMe)
node scripts/spike/colibri/benchmark.mjs --models <gguf1>,<gguf2> --vs ollama 2>/dev/null || true
```
Ожидаемо: colibri отвечает через OpenAI API (1–2 frontier-MoE); замер vs Ollama (latency/throughput/VRAM/RAM/диск/NVMe-стриминг) зафиксирован; отчёт-вердикт GO/PARALLEL/NO-GO + рекомендации по AD-D2 задокументирован; production-код НЕ изменён; closed-contour (self-hosted, локально).

## Open Questions

1. **Какие 1–2 frontier-MoE модели для spike?** Рекоменdация: одна 100B–200B MoE (NVMe-класс, недоступный Ollama) + одна 30–70B (сравнение с Ollama на overlapping-классе). Обоснование: показать и уникальность (100B+), и сравнимость (30–70B). Dev-уточнить доступные GGUF.
2. **Вердикт PARALLEL — как разделить бэкенды?** Рекоменdация: по классу моделей (frontier-MoE 100B+ → colibri, остальные → Ollama) + capability-маркер (entry 1). Обоснование: не замена, а дополнение.
3. **Spike-сервис в compose — временный или постоянный?** Рекоменdация: временный (spike-стенд, не в production-пути); если GO — постоянный (environment-model + drift, pattern 1.12 D2). Обоснование: spike = research.
4. **Влияние на AD-D2: вердикт меняет write-owner?** Рекоменdация: вердикт = рекомендация, AD-D2 меняет architectural-решение (не в обход spike). Обоснование: AD-D2 = data-spine (write-owner model-weights), colibri = кандидат GGUF-пути.
5. **HITL: доступ к пилот-хосту/железу?** Рекоменdация: spike требует реального железа (RAM/NVMe/GPU) — HITL-доступ к пилот-хосту. Обоснование: hierarchical offloading зависит от железа.
