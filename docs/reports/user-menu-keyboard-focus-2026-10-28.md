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

Production TypeScript (`tsc --noEmit --incremental false`) passed in 7.603 seconds with unchanged source hashes, an absent owned process group and the private profile removed. A fresh desktop browser retest is pending. This report does not claim screen reader or OS acceptance.
