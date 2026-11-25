---
title: "BUG (RES-01 stage 2, FIXED 2feb49d3, live-верифицирован 2026-11-25: used=704 = Σ delta_bytes, delivery идёт intent-ключами): quota-accounting доставка разбита ключом — rag-sync и skills шлют requestKey (camelCase), catalog парсит request_key (snake_case) → ВСЕ delivery 400 → retentionBytesUsed/currentBytesUsed не накапливаются (used всегда 0)"
ticket: 27
status: done
---
