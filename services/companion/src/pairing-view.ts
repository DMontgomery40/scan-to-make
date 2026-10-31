// `svg` is trusted markup generated locally by qrcode, never request data.
const STYLE = `
:root{color-scheme:light dark;--fg:#111;--muted:#555;--bg:#f4f4f5;--card:#fff;--rule:#e4e4e7}
@media (prefers-color-scheme:dark){:root{--fg:#f4f4f5;--muted:#a1a1aa;--bg:#18181b;--card:#27272a;--rule:#3f3f46}}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--rule);border-radius:16px;padding:28px 24px;text-align:center}
h1{margin:0 0 8px;font-size:1.5rem;line-height:1.25;font-weight:650}
p{margin:0 0 12px}
.lead{font-size:1.0625rem}
.muted{color:var(--muted);font-size:.9375rem}
.qr{width:min(100%,360px);margin:20px auto;padding:16px;background:#fff;border-radius:12px;border:1px solid #d4d4d8}
.qr svg{display:block;width:100%;height:auto}
time{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
@media (max-width:420px){body{padding:12px}main{padding:22px 16px}.qr{padding:12px}}
`;
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatExpiry(expiresAt: number): { label: string; iso: string } {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return { label: "", iso: "" };
  return {
    label: date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
    iso: date.toISOString(),
  };
}
function page(title: string, body: string, refresh: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
${refresh ? '<meta http-equiv="refresh" content="5">\n' : ""}<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
export function renderPairingPage(svg: string | null, expiresAt: number): string {
  if (svg === null) {
    return page(
      "Pairing code unavailable · Scan to Make",
      `<h1>This pairing code is no longer available</h1>
<p class="lead">It expired or has already been used.</p>
<p class="muted">To pair an iPhone, start pairing again from the companion in Terminal.</p>`,
      false,
    );
  }
  const expiry = formatExpiry(expiresAt);
  const expiryText = expiry.label
    ? `It works once and expires after five minutes, at <time datetime="${escapeHtml(expiry.iso)}">${escapeHtml(expiry.label)}</time>.`
    : "It works once and expires after five minutes.";
  return page(
    "Pair your iPhone · Scan to Make",
    `<h1>Pair your iPhone</h1>
<p class="lead">Open the Camera app on your iPhone, point it at this code, then tap the Scan to Make banner.</p>
<div class="qr" role="img" aria-label="Pairing QR code. Scan it with the iPhone Camera app.">${svg}</div>
<p class="muted">${expiryText}</p>
<p class="muted">Don't share this code. A phone that can connect to this computer could use it to pair.</p>`,
    true,
  );
}
