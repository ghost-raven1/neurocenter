# Model details close and keyboard focus

Feature base: Main `991b1101cc3fb2adc49611f93b36481089b8297f`. The live G contour remains unchanged at `24634caa`.

The G browser check opened ModelDetails from the actual model-title button. Ten Tab/ShiftTab steps stayed inside the modal, but Escape closed it with focus on `BODY`. A second settled attempt reproduced this with document focus present. The raw evidence is `phase-g-ui/f62-g-model-modal-menu.json` and `f62-g-model-repeat-interruption-readback.json`. That browser evidence did not record whether its opener stayed connected; the new component regression does.

ModelCatalog conditionally mounts ModelDetails. Its original `onCancel` immediately cleared the selection, unmounting AntD Modal before its closing lifecycle could restore the opener. ModelDetails now closes its local `open` state and notifies the parent through `afterClose`. AntD restores focus before this callback. Busy close remains blocked; edit/configure/archive handoffs retain their existing callbacks. ModelCatalog and its ownership/context logic are unchanged.

The new jsdom test renders actual ModelCatalog, ModelCard, ModelDetails and AntD Modal. Network/hosting/quota hooks and unrelated sibling views are isolated; Modal, its focus handling and its conditional consumer are not mocked. It supplies platform visibility because jsdom has no layout, waits for modal focus, and checks focus after closing/frame callbacks. Both Escape and the footer close button must return to the still-connected title. It then opens and closes a different model to prove the next modal has fresh state. No assignment or refresh is called.

Evidence in `.run/model-details-focus-20261028/`:

- `red/`: unchanged production, 14 passed / 2 failed. Both close routes leave focus on `BODY` despite a connected opener.
- `green/`: identical tests, 16 passed / 0 failed; this includes14 existing model-card/hosting checks. The only production difference is ModelDetails' close lifecycle.
- Both runs used cached Node24.22, max1worker,1024MiB old-space, a clean environment/private HOME/TMP, unchanged source hashes and positive whole-process-group absence. Profiles were removed. No browser, database, model or external API ran for this feature.

Production TypeScript and a fresh browser regression are pending. This is a component result, not a replacement for the failed G browser criterion or a screen-reader/OS claim.
