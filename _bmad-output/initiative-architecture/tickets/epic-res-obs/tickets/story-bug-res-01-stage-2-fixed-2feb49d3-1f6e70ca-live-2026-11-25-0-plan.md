---
title: "BUG (RES-01 stage 2, FIXED 2feb49d3+1f6e70ca, live-верифицирован 2026-11-25: снапшот 0644, snapshot_available=1, CapacityUnavailable снят): capacity-снапшот нечитаем сервисами в production-compose — collector от root (user 0) пишет /capacity/snapshot.json 0600 root:root, сервисы от uid 1000 → EACCES → snapshot_available=0 → все capacity-операции fail-closed 503"
ticket: 26
status: done
---
