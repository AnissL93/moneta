import type { FastifyInstance } from "fastify";

// Static shell only (spec §41): no data is inlined here — the inline script
// fetches /status with the bearer token the user enters (kept in localStorage).
const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moneta</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; background: #fafafa; color: #222; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  .card { background: #fff; border: 1px solid #e2e2e2; border-radius: 8px; padding: .8rem 1rem; margin: .6rem 0; }
  .ok { color: #1a7f37; } .warn { color: #b35900; } .err { color: #c0392b; }
  button { padding: .35rem .8rem; border: 1px solid #bbb; border-radius: 6px; background: #f4f4f4; cursor: pointer; }
  button:hover { background: #eaeaea; }
  .muted { color: #777; font-size: .85rem; }
  input { padding: .4rem; width: 100%; box-sizing: border-box; }
  #token-form { margin: 1rem 0; }
</style>
</head>
<body>
<h1>Moneta</h1>
<div id="token-form" class="card">
  <p>API token (stored only in this browser):</p>
  <input id="token" type="password" placeholder="API_TOKEN from .env">
  <p><button id="save-token">Save & load</button></p>
</div>
<div id="content"></div>
<script>
const $ = (id) => document.getElementById(id);
const tokenKey = "moneta-token";

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: "Bearer " + localStorage.getItem(tokenKey), ...(options.headers ?? {}) },
  });
  if (response.status === 401) { localStorage.removeItem(tokenKey); render(); throw new Error("unauthorized"); }
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function fmtDate(value) { return value ? new Date(value).toLocaleString() : "never"; }
function fmtBalance(balance) {
  if (!balance || balance.currentMinor === null) return "";
  const amount = Number(balance.currentMinor) / 100;
  return amount.toLocaleString(undefined, { style: "currency", currency: balance.currency });
}
function statusClass(status) {
  return status === "ACTIVE" || status === "SUCCESS" ? "ok" : status === "REAUTH_REQUIRED" ? "warn" : "err";
}

async function load() {
  const status = await api("/status");
  const parts = [];
  parts.push('<p><button id="sync-now">Sync now</button> <span class="muted" id="sync-note"></span></p>');
  for (const connection of status.connections) {
    const rows = connection.accounts.map((account) =>
      \`<div>\${account.name} — \${fmtBalance(account.latestBalance)} <span class="muted">\${account.transactionCount} transactions, synced \${fmtDate(account.lastSuccessfulSync)}</span></div>\`,
    ).join("");
    const reconnect = connection.status === "REAUTH_REQUIRED"
      ? \`<button data-reconnect="\${connection.id}">Reconnect</button>\` : "";
    parts.push(\`<div class="card"><strong>\${connection.institutionName ?? "Bank"}</strong>
      <span class="\${statusClass(connection.status)}">\${connection.status}</span> \${reconnect}
      <div class="muted">Last sync: \${fmtDate(connection.lastSuccessfulSync)}</div>\${rows}</div>\`);
  }
  if (status.connections.length === 0) parts.push('<div class="card">No bank connections yet — see docs/truelayer-setup.md</div>');
  if (status.lastRun) {
    const errors = status.lastRun.errors.map((e) => \`<div class="err">\${e.errorType}: \${e.message}</div>\`).join("");
    parts.push(\`<h2>Last sync run</h2><div class="card"><span class="\${statusClass(status.lastRun.status)}">\${status.lastRun.status}</span>
      <span class="muted">\${fmtDate(status.lastRun.finishedAt)}</span>\${errors}</div>\`);
  }
  parts.push(\`<p class="muted">Actual Budget: \${status.actualConfigured ? "configured" : "not configured"} ·
    <a href="#" id="csv-link">Export CSV</a></p>\`);
  $("content").innerHTML = parts.join("");

  $("sync-now").onclick = async () => {
    $("sync-note").textContent = "syncing…";
    try { await api("/sync", { method: "POST" }); $("sync-note").textContent = "done"; await load(); }
    catch (error) { $("sync-note").textContent = "failed: " + error.message; }
  };
  $("csv-link").onclick = async (event) => {
    event.preventDefault();
    const response = await fetch("/export/transactions.csv", { headers: { Authorization: "Bearer " + localStorage.getItem(tokenKey) } });
    const blob = await response.blob();
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "transactions.csv" });
    link.click();
  };
  for (const button of document.querySelectorAll("[data-reconnect]")) {
    button.onclick = async () => {
      const session = await api("/connections/" + button.dataset.reconnect + "/reauthorize", { method: "POST" });
      window.open(session.authUrl, "_blank");
    };
  }
}

function render() {
  const hasToken = Boolean(localStorage.getItem(tokenKey));
  $("token-form").style.display = hasToken ? "none" : "block";
  if (hasToken) load().catch((error) => { $("content").innerHTML = '<div class="card err">' + error.message + "</div>"; });
}

$("save-token").onclick = () => { localStorage.setItem(tokenKey, $("token").value.trim()); render(); };
render();
</script>
</body>
</html>`;

export function registerUiRoutes(server: FastifyInstance): void {
  server.get("/ui", async (_request, reply) => reply.type("text/html; charset=utf-8").send(PAGE));
}
