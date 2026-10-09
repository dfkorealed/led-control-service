/** Fail closed: only an explicitly configured public HTTPS destination can open login. */
export function getPublicServiceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.search) return null;
    // Local/IP hosts and short-lived preview providers must never activate the public login.
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
      || /^[\d.]+$/.test(host)
      || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|home\.arpa|test|invalid|example)$/.test(host)
      || /(?:^|\.)(?:example\.(?:com|net|org)|ngrok(?:-free)?\.(?:app|io)|trycloudflare\.com|loca\.lt|vercel\.app|netlify\.app|pages\.dev|github\.io)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}
