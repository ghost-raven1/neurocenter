# Research: ландшафт self-hosted AI-agent / LLM-платформ — 2026-11-05

Источник: web-исследователь (recon-саб-агент), вход для PRD neurocenter. Свежие источники 2025–2026, ссылки — в тексте.

## Позиционирование сопоставимых

| Продукт | Для кого | Что умеет | Чего нет |
|---|---|---|---|
| **OpenClaw** (ex-Clawdbot/Moltbot) | Hobby/личный агент, single-user | 13k+ скиллов (ClawHub), 29 мессенджер-каналов, persistent memory, локальные LLM, «for Teams» gateway | Multi-tenancy, RBAC, audit, DR, device pairing/revocation; trust подорван supply-chain-кризисом |
| **Onyx** (ex-Danswer) | Enterprise knowledge search + sandboxed agents | Permission-aware RAG 50+ коннекторов, MCP-действия, локальные LLM (Ollama/vLLM), air-gap, K8s | Это search/chat-слой, не рантайм+каталог; RBAC/SSO — enterprise-licensed |
| **Dify** | Dev/стартап-пилоты, low-code агенты | Visual builder, RAG, agent+tool calling, 100+ моделей, observability | Open-core: EE (SSO/SAML, RBAC, audit, multi-workspace) — лицензионный ключ + внешний Enterprise API |
| **Open WebUI** | Self-hosted «внутренний ChatGPT» | SSO (OIDC/OAuth), SCIM, RBAC, groups, audit — бесплатно в core; air-gapped, Ollama-native, MCP | Enterprise = только white-label, Terminals, SLA |
| **LibreChat** (MIT) | IT-команды, multi-model chat | Multi-provider UI, agents, code execution, RAG, MCP, OAuth/SAML/LDAP/2FA | «Chat frontend, not a governance platform» |
| **AnythingLLM** (MIT) | Индивиды/малые команды, private RAG | Самая простая private RAG; cloud $50–99/mo | Слабая коллаборация, нет enterprise-коннекторов |
| **LobeChat** (Apache-2.0) | Self-hosted UI | Plugin+agent marketplace, RAG, Ollama | Marketplace живёт в облаке; self-hostable market server — только feature request |
| **n8n / Windmill** | No-code/developer-автоматизация | MCP, agent nodes; Windmill: roles + path ACLs | n8n fair-code (SUL), RBAC/SSO платные; Windmill CE: 50 юзеров, durable audit — EE |
| **OpenHands** (MIT core) | Coding-агенты | Sandboxed execution, skills+MCP, GitHub/Slack-триггеры | OSS = 1 юзер; SSO/SAML, RBAC, audit, cost controls — только Enterprise |
| **Arcade / Composio / Nango** (MCP-gateway-слой) | Enterprise governance доступа к MCP-тулам | Per-user auth, scoped Virtual MCP servers, SSO/RBAC/audit, self-host/air-gap | Не chat-продукт, нет LLM-рантайма, нет per-project data plane, нет DR |
| **Свежие 2025–2026**: NemoClaw (NVIDIA-форк OpenClaw), Hermes Agent, Pinchy (AGPL, governed agents: allow-list + HMAC-signed audit) | Enterprise-пилоты/teams | Self-hostable preview; per-agent tool allow-listing | Все young: без DR/restore, без versioned catalog, без compliance |

## Ниша Neurocenter

«device bridge (устройства операторов = MCP-клиенты) + per-project data + offline/DR-first» **не занята никем целиком**. Ближайшие соседи по кусочкам:
- **Arcade/Composio/Nango** — ближе к «устройства = MCP-клиенты к self-hosted ядру с governance», но только auth/gateway-слой (нет рантайма, RAG, чата, pairing, DR).
- **OpenClaw/NemoClaw** — ближе по UX «операторское устройство ↔ агент», но single-user, без device identity, без per-project изоляции, без DR.
- **Onyx** — ближе к «enterprise, offline, permission-aware RAG + локальные LLM + air-gap», но search/chat-слой, не agent-рантайм с каталогом и device-мостом.
- **Dify/Open WebUI/LibreChat** — chat/app-builder с enterprise-фичами, но server-side multi-tenant, без device-примитивов и DR-first.

**Дыра:** никто не комбинирует (a) локальный LLM-рантайм (GGUF/ollama) + (b) версионированный каталог агентов/плагинов/моделей + (c) per-project RAG + (d) device pairing/revocation через MCP + (e) offline quiesced backup + air-gapped restore + (f) single-host compose. Каждый конкурент закрывает 1–3 пункта.

## Табличные ожидания рынка (без них — дисквалификация)

- SSO (OIDC/SAML) + RBAC + groups
- Audit logs
- Поддержка локальных LLM (Ollama/vLLM)
- MCP-поддержка (де-факто стандарт)
- Air-gapped deployment
- Document RAG

**Что у рынка нет/платное → дифференциаторы Neurocenter:** versioned agent/plugin/model catalog (LobeChat — облако, OpenClaw — недоверенный ClawHub); device pairing/revocation (не у кого); DR-first offline restore (air-gapped restore + quiesced backup → S3); runtime-limits/maintenance UI; evals (почти нигде).

## Критики / красные флаги рынка

1. **Supply chain экосистем скиллов/плагинов**: Snyk — 36.8% (1467) agent skills имеют security issues, 13.4% critical (malware, prompt injection, credential theft); «ClawHavoc» — 824+ malicious skills из 10,700+ в ClawHub (16.02.2026); аудит Trellix (янв 2026) — 512 уязвимостей, 8 critical.
2. **RCE и prompt injection в рантаймах агентов**: CVE-2026-25253 (zero-click RCE), CVE-2026-30741; системные паттерны: over-privileged tools, plaintext secrets, нет тестов на indirect prompt injection.
3. **Supply chain моделей**: злонамеренные модели в публичных репозиториях (backdoors, стегано-экфильтрация); self-managed модели = shadow AI blind spot.
4. **Update-процессы**: инициатива «cool-off period» против auto-update-атак (r/selfhosted); жалобы на update stability OpenClaw.
5. **Open-core недоверие**: SSO/RBAC/audit постоянно уходят в EE (Windmill CE: 50 юзеров, audit retention 14 дней; Onyx, Dify, n8n). Для Neurocenter (one-tenant, internal) — аргумент: runtime-лимиты, audit, pairing без лицензионного шлюза.

## Вывод для PRD

**Problem statement (гипотеза для подтверждения):** «Корпоративным операторам нужен AI-ассистент, который работает **внутри контура** (локальный LLM, air-gap, без внешних зависимостей в рантайме), при этом платформа должна **управляться как инфраструктура**: версионированный каталог агентов/моделей/плагинов, per-project изоляция данных, device pairing/revocation и **восстановление** (не «deployable air-gapped», а quiesced backup + restore)».

Why: рынок 2025–2026 разделился на (1) personal-agent-фреймворки (вирусные, без enterprise-контроля, объект supply-chain-кризисов) и (2) enterprise-платформы (governance есть, но нет device-bridge + DR-first + single-host простоты). Ниша Neurocenter = пересечение; табличные ожидания покрывают «не удивим», versioned catalog + device lifecycle + offline restore — дифференциатор.
