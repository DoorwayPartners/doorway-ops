# Deploying Doorway Ops (ops.doorwaypartners.com)

Everything below is **free**. The code is already done and tested (`npm test`).
Steps marked **[Cristian]** need your Google / GoDaddy / GitHub login. Nothing
here touches the existing Payroll-bound script, the Doorway Fidium Pipeline
script, or the doorwaypartners.com site repo.

Preview first, no setup needed: `npm run preview` then open
`http://localhost:8787/?demo=1` (all data fake). Screens: `screens/*.png`.

---

## 1. Create the Google OAuth client ID — [Cristian], ~5 min, free
1. Go to <https://console.cloud.google.com/> signed in as cristian@doorwaypartners.com.
2. Create (or pick) a project, e.g. **Doorway Ops**.
3. **APIs & Services → OAuth consent screen**: User type **External**, app name
   "Doorway Ops", support email = yours. Scopes: only the defaults
   (`openid`, `email`, `profile`). Publish the app ("In production") so reps
   with any Google account can sign in. (These basic scopes need no Google review.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**, name "Doorway Ops web".
   - Authorized JavaScript origins: `https://ops.doorwaypartners.com`
     (optionally also `http://localhost:8787` for local testing).
   - No redirect URIs needed. **Do not** create or share a client secret; it is not used.
5. Copy the **Client ID** (`…apps.googleusercontent.com`). It is public by design.

## 2. Add the Portal_Users tab — [Cristian approves], 2 min
In **Doorway Partners — 1099 Commission & Payroll Master**, add a tab named
exactly `Portal_Users` with this header row:

| Email | Name | Role | Manager_Name | Active | Assigned_Towns | Notes |
|---|---|---|---|---|---|---|

- `Role` is one of `Owner`, `Admin`, `Manager`, `Rep`. `Active` must be TRUE/checked.
- `Name` must match `Rep_Name` in Order_Ledger / Compliance_Tracker.
- A Manager sees every Rep whose `Manager_Name` is their `Name` (here or in Compliance_Tracker).
- `Assigned_Towns` (optional, comma-separated) drives the Rep permit card; blank = towns from their orders.
- Anyone not listed, or not Active, gets a 403 and sees nothing.

Either type it by hand, ask Brooklynn to create it with the Sheets connector,
or paste `setup/PortalUsersSetup.gs` into a throwaway Apps Script project and
run `createPortalUsersTab()` (it refuses to overwrite an existing tab and seeds
your Owner row). The deployed web app itself only has read-only Sheets access.

## 3. Create and deploy the standalone Apps Script — [Cristian signs in once]
On Brooklynn's computer:
```bash
clasp login                    # [Cristian] one-time Google sign-in in the browser
cd apps-script
clasp create --type standalone --title "Doorway Ops API"   # NEW project, writes .clasp.json (git-ignored)
clasp push                     # pushes Code.js, Core.js, appsscript.json only
```
Then in the Apps Script editor (`clasp open`):
1. **Project Settings → Script properties**, add:
   - `OAUTH_CLIENT_ID` = the client ID from step 1
   - `PAYROLL_SHEET_ID` = ID of **1099 Commission & Payroll Master**
   - `RECON_SHEET_ID` = ID of **Master Turf Sheet — SalesRabbit Reconciliation**
   - `EXPENSE_SHEET_ID` = ID of **Trip & Ops Expense Ledger**
   (Sheet IDs are deliberately kept out of this repo; Brooklynn has them.)
2. **Deploy → New deployment → Web app**:
   - Execute as: **Me (cristian@doorwaypartners.com)**
   - Who has access: **Anyone**
   - Authorize when asked (read-only Sheets + external requests for Google tokeninfo).
   The deployment setting is *not* the gate; the server verifies every request's
   Google ID token (signature/expiry via Google tokeninfo, plus `aud` = your
   client ID, `iss`, `exp`, `email_verified`) and the Portal_Users allowlist.
3. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
   Later code updates: `clasp push` then **Deploy → Manage deployments → Edit → New version**
   (keeps the same URL).

## 4. Point the site at the API — Brooklynn, 1 min
Edit `docs/config.js`: set `GOOGLE_CLIENT_ID` and `API_URL`. Commit and push to `main`.

## 5. GitHub Pages — [Cristian decides on plan]
Repo: `DoorwayPartners/doorway-ops` (private). Pages source: **main / docs**
(the `docs/CNAME` file already says `ops.doorwaypartners.com`).
- GitHub Pages on a **private** repo needs a paid plan (GitHub Pro, $4/mo for a
  personal account). On the free plan the repo must be made **public** to use
  Pages. The repo has no secrets (client ID and script URL are public by design,
  and the data is behind token verification), but that call is yours.
- Then: **Settings → Pages → Build and deployment: Deploy from a branch → main → /docs**,
  custom domain `ops.doorwaypartners.com`, tick **Enforce HTTPS** once the cert is issued.

## 6. GoDaddy DNS — [Cristian]
In GoDaddy → doorwaypartners.com → DNS → **Add record**:
- Type **CNAME**, Name **ops**, Value **doorwaypartners.github.io**, TTL default.
Leave every existing record (the main site) as is.

## 7. Test the four roles
Add four Portal_Users rows (one per role, real Google accounts), sign in at
<https://ops.doorwaypartners.com>, and confirm: Rep sees only their own orders,
Manager sees their pod with no margins or other reps' addresses, Admin sees all
with "Payout release is Owner-only", Owner sees all. An unlisted account must get "No access".
