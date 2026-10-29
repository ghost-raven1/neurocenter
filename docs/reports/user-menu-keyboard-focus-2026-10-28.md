# User menu keyboard focus

Base: Main `991b1101cc3fb2adc49611f93b36481089b8297f`.

The desktop F62-02 check opened the user menu from its keyboard trigger, moved focus into its menu, and pressed Escape. The popup closed, but focus remained on `BODY` after settling. The trigger also lacked `aria-haspopup` and `aria-expanded`. The original browser evidence remains in the Phase F `f62-02-user-menu-{settled,stable-focus}.json` artifacts; Phase F remains a failed keyboard case until a browser retest.

`UserInfo` now handles Escape during capture only for events originating inside its menu. This prevents AntD's menu from queuing a focus move into the closing popup, closes the controlled dropdown, and focuses the trigger. Its accessible popup state follows the same controlled state. Ordinary menu selection also closes it. Outside clicks and notification settings do not invoke this focus restoration.

The real AntD Dropdown, Button, Menu and Modal run in jsdom. Redux/router boundaries and notification settings content are mocked. Layout visibility is supplied because jsdom has no layout. Native button Enter activation is followed by its normal click explicitly because jsdom does not synthesize that browser default. Keyboard events include `which` and `keyCode`, and the Escape assertion waits for queued animation frames.

Evidence in `.run/user-menu-keyboard-20261028/`:

- `red/`: initial fixture check, 6 passed / 2 failed. It established missing ARIA but checked Escape too early; the modal assertion also ran too early. It is not the causal focus proof.
- `red-settled/`: unchanged production, corrected platform events and frame settling, 6 passed / 2 failed. Missing ARIA and focus restoration fail. The real menu's deferred callback moves focus into a hidden menu item in jsdom; the desktop browser had observed `BODY`.
- `green/`: identical tests, 8 passed / 0 failed. The two unaffected controls also pass: outside-click target keeps focus, and notification settings receive modal focus. Four existing role/menu tests remain green.

Each run used cached Node 24.22, one worker, a clean environment and private HOME/TMP. Receipts record unchanged source hashes, positive process-group absence, and private profile removal. No API, database, model or browser operations ran for this feature.

Production TypeScript (`tsc --noEmit --incremental false`) passed in 7.603 seconds with unchanged source hashes, an absent owned process group and the private profile removed. The targeted desktop browser retest passed as described below. This report does not claim screen reader or OS acceptance.

## Targeted desktop retest on G

On combined source `24634caafc02f30dbcd489bfb3d1e9cccb2b3ae0`, Playwright used actual Tab/Enter to open the user menu and Tab to focus its real role=menu. Escape closed it and returned focus to the original user trigger after animation frames and a1.5s settled check. The trigger exposed aria-haspopup=menu and aria-expanded=true→false. No account action or business write occurred: write count13→13.

Raw UI evidence: `bridge-first-local-setup` worktree `output/playwright/full-functional-acceptance-20261028/phase-g-ui/f62-g-model-modal-menu.json`, SHA `049cb3c9067fbbaf9efd65d6a5ac471ed09e73fc38e68ef02410a691e5c0807c`. Root independently reviewed the keyboard/ARIA/focus records and confirmed this targeted fix. The same eight component tests, frontend TypeScript and production Vite build also passed on G.

The complete F62-02 remains FAIL at this checkpoint because a separate ModelDetails modal loses focus on close; that defect has its own fix and acceptance. This menu retest does not turn the whole case into PASS. CI and production are not claimed.
