# Model details close and keyboard focus

Feature base: Main `991b1101cc3fb2adc49611f93b36481089b8297f`. The live G contour remains unchanged at `24634caa`.

The G browser check opened ModelDetails from the actual model-title button. Ten Tab/ShiftTab steps stayed inside the modal, but Escape closed it with focus on `BODY`. A second settled attempt reproduced this with document focus present. The raw evidence is `phase-g-ui/f62-g-model-modal-menu.json` and `f62-g-model-repeat-interruption-readback.json`. That browser evidence did not record whether its opener stayed connected; the new component regression does.

ModelCatalog conditionally mounts ModelDetails. Its original `onCancel` immediately cleared the selection, unmounting AntD Modal before its closing lifecycle could restore the opener. ModelDetails now closes its local `open` state and notifies the parent through `afterClose`. AntD restores focus before this callback. Busy close remains blocked; edit/configure/archive handoffs retain their existing callbacks. ModelCatalog and its ownership/context logic are unchanged.

The new jsdom test renders actual ModelCatalog, ModelCard, ModelDetails and AntD Modal. Network/hosting/quota hooks and unrelated sibling views are isolated; Modal, its focus handling and its conditional consumer are not mocked. It supplies platform visibility because jsdom has no layout, waits for modal focus, and checks focus after closing/frame callbacks. Both Escape and the footer close button must return to the still-connected title. It then opens and closes a different model to prove the next modal has fresh state. No assignment or refresh is called.

Evidence in `.run/model-details-focus-20261028/`:

- `red/`: unchanged production, 14 passed / 2 failed. Both close routes leave focus on `BODY` despite a connected opener.
- `green/`: identical tests, 16 passed / 0 failed; this includes14 existing model-card/hosting checks. The only production difference is ModelDetails' close lifecycle.
- Both runs used cached Node24.22, max1worker,1024MiB old-space, a clean environment/private HOME/TMP, unchanged source hashes and positive whole-process-group absence. Profiles were removed. No browser, database, model or external API ran for this feature.

The combined H2 candidate passed frontend TypeScript and production Vite build. The first combined test run exposed only a missing Redux Provider in the optional quota child; a test-only Viewer boundary fixed the fixture and the16 tests passed. The original failure is retained. Neither the production fix nor the G backend changed.

## Desktop H2 acceptance

The checked frontend `dfc71c10fe0cf0f88084c023d2963e95dc444972` differs from G in only this production ModelDetails module; all864 other public source files match. Its own Auth/Gateway copies use the ordinary QA principal and the unchanged G Catalog backend `24634caa`, with no cookie transfer or Origin rewrite.

Playwright on1440×1000/reduced-motion passed the complete F62-02 path: native project-form keyboard navigation, linked aria-invalid/describedby/alert and Escape return with0POST;10 native Tab/ShiftTab steps trapped in ModelDetails, then Escape returning to the exact original connected title; a second native footer-Enter close also returned to that same opener. User-menu state/focus and chat Escape→Cancel→retained draft/input focus→Escape→Continue→launcher focus passed. No model-chat creates/turns or business writes occurred; page errors0. The browser tool reported no open tabs afterward.

UI receipt SHA `96e8821a5724e6ad25dc101e05530b0de8066d645554e5bef4dcd217d9cf70da`,12-file manifest SHA `6a42d642ebc5e17199459a52951a2a1bb2b5266d74a146f83e4b252825678040`; independent exact-case mapping SHA `587a26e43e06665fe468ab1c0a8b93078285cc0ebe64afddd2a027b068b6a052`. Raw evidence is in `model-focus-acceptance/output/playwright/model-focus-h2-20261028/`, mapping in Original `.run/phase-h2-review/`. Failing G attempts remain historical evidence. Screen reader, hardware, CI and production are not claimed.
