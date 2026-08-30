# TrueLayer Setup Guide

The service talks to TrueLayer's Data API v1 (see spec ADR-006). You need a
TrueLayer console account and app credentials before any bank can be connected.

## 1. Create a TrueLayer app

1. Sign up at <https://console.truelayer.com>.
2. Create an application. You get a **sandbox** client automatically; live
   access requires a separate approval request — start it early (spec §48).
3. In *App settings → Redirect URIs*, add exactly:

   ```text
   http://localhost:3000/auth/truelayer/callback
   ```

4. Under *Data → Scopes*, enable: `info`, `accounts`, `balance`,
   `transactions`, `offline_access`.

## 2. Configure the service

Fill in `.env`:

```env
TRUELAYER_CLIENT_ID=sandbox-xxxx
TRUELAYER_CLIENT_SECRET=xxxxxxxx
TRUELAYER_REDIRECT_URI=http://localhost:3000/auth/truelayer/callback
TRUELAYER_ENVIRONMENT=sandbox
APP_ENCRYPTION_KEY=<openssl rand -hex 32>
API_TOKEN=<openssl rand -hex 24>
```

Restart the stack: `docker compose up -d --build moneta`.

Without TrueLayer credentials the service still starts, but connection routes
return `503 truelayer not configured`.

## 3. Connect a sandbox bank

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/connections/truelayer
```

Open the returned `authUrl` in a browser, choose **Mock Bank** (`uk-cs-mock`),
and log in with the sandbox credentials `john` / `doe`. After consenting you
are redirected to the callback and should see
"Bank connected — N account(s) discovered."

## 4. Verify

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/connections
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/accounts
```

`/accounts` should list the mock accounts with balances in integer minor units
(pence, as strings).

## 5. Reauthorize / disable

```bash
# When a connection shows REAUTH_REQUIRED, get a fresh auth URL bound to it:
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/connections/<id>/reauthorize

# Soft-disable (history is kept):
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/connections/<id>
```
