# Doorway Ops — Command Center (ops.doorwaypartners.com)

Mobile-first, read-only dashboard for Doorway Partners, backed by the existing Google Sheets.

- `docs/` — static site served by GitHub Pages (plain HTML/JS/CSS, Google Sign-In). `?demo=1` = fake-data preview.
- `apps-script/` — standalone Apps Script web app. Verifies the Google ID token server-side,
  maps the email to a role via `Portal_Users`, and returns only what that role may see.
- `apps-script/Core.js` — the pure filtering logic (copied to `docs/core.js` by `npm run build`, so the demo
  uses the exact same code as the server).
- `setup/PortalUsersSetup.gs` — optional one-time helper to create the `Portal_Users` tab (not deployed).
- `test/` — Node unit tests proving Rep/Manager payloads never contain margins or other reps' data.

| Role | Sees |
|---|---|
| Owner | Everything, incl. margins, expenses, payout-release capability |
| Admin | Everything except payout release |
| Manager | Their pod's scoreboard, orders (no margins; other reps' customer names/addresses stripped), Day-14, missing orders (town only), own wallet, permits |
| Rep | Own wallet (pending/installed/cleared, 90-day clawback countdown), compliance badge, tier progress, pace, own permits/knock hours, own Day-14, own scorecard, own missing pins |

```bash
npm test          # unit tests (Node 18+)
npm run preview   # http://localhost:8787/?demo=1
npm run screens   # headless Chrome screenshots -> screens/
```

See **DEPLOY.md** for the remaining human steps. V1 never writes to any sheet.
