// Connection to the contribution server (server/server.py).
//
// Leave API_BASE empty and the app works exactly as before: suggestions stay on the
// phone and travel by Export/Import. Set it to your server's HTTPS address, e.g.
//   export const API_BASE = 'https://mog-api.example.org';
// and Contribute gains accounts, logged or anonymous sending, review and admin tools.
// Testing from a phone on the same Wi-Fi: use the laptop's network address, not 127.0.0.1
// (on a phone, 127.0.0.1 is the phone itself). Real use needs an https:// address.
export const API_BASE = 'https://dislike-gossip-city.ngrok-free.dev';

// The address can also be changed inside the app (Contribute → Change server), for
// example to a tunnel address that changes. That choice is kept on this device and
// wins over API_BASE until it is reset.
const SERVER_KEY = 'mog.server';
export const serverBase = () => {
  let v = null;
  try { v = localStorage.getItem(SERVER_KEY); } catch { /* private mode */ }
  return (v || API_BASE).replace(/\/+$/, '');
};
export const serverIsCustom = () => { try { return !!localStorage.getItem(SERVER_KEY); } catch { return false; } };
// Accepts "abc.trycloudflare.com" or a full address. Empty resets to the built-in one.
export function setServer(input) {
  let v = String(input || '').trim();
  if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
  if (v) {
    let u;
    try { u = new URL(v); } catch { throw new Error('That is not a web address.'); }
    v = u.origin;
  }
  const before = serverBase();
  try { if (v) localStorage.setItem(SERVER_KEY, v); else localStorage.removeItem(SERVER_KEY); } catch { /* private mode */ }
  // A login and published list belong to one server; drop them when the server changes.
  if (serverBase() !== before) { session.clear(); try { localStorage.removeItem('mog.published'); } catch { /* ignore */ } }
  return serverBase();
}

export const online = () => !!serverBase();

const KEY = 'mog.session';
export const session = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
  set(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* private mode */ } },
};

/**
 * Calls the server. `auth: false` sends no login at all; anonymous (unlogged)
 * suggestions use it so nothing on the wire ties them to an account.
 */
// An address that no longer exists (e.g. a laptop that changed network) can leave a
// request hanging forever; give up instead so the page can say so.
const TUNNEL_HEADERS = { 'ngrok-skip-browser-warning': '1' };
const timeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  // ngrok's free plan answers browsers with a warning page unless this header is sent.
  const headers = { 'Content-Type': 'application/json', ...TUNNEL_HEADERS };
  const s = session.get();
  if (auth && s && s.token) headers.Authorization = 'Bearer ' + s.token;
  let res;
  try {
    res = await fetch(serverBase() + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined,
      credentials: 'omit', cache: 'no-store', signal: timeout(body && body.audio ? 60000 : 10000),
    });
  } catch {
    const e = new Error('No connection to the server. Check you are online, or change the server address.'); e.offline = true; throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && headers.Authorization && path !== '/api/login') session.clear();   // signed out elsewhere
  if (!res.ok) { const e = new Error(data.error || `Server error (${res.status})`); e.status = res.status; throw e; }
  return data;
}

// Address of a published recording (public, so it can be an <audio src>).
export const audioUrl = (id) => `${serverBase()}/api/audio/${id}`;
// Plays a server recording through fetch (so the tunnel header is sent), as a blob: URL.
export async function audioSrc(url) {
  const res = await fetch(url, { headers: TUNNEL_HEADERS, credentials: 'omit', signal: timeout(30000) });
  if (!res.ok) throw new Error('Could not load the recording');
  return URL.createObjectURL(await res.blob());
}
// An unpublished recording, for reviewers and the person who sent it (needs the login).
export async function fetchAudio(id) {
  const s = session.get();
  const res = await fetch(audioUrl(id), { headers: { ...TUNNEL_HEADERS, ...(s && s.token ? { Authorization: 'Bearer ' + s.token } : {}) }, credentials: 'omit', signal: timeout(30000) });
  if (!res.ok) throw new Error('Could not load the recording');
  return res.blob();
}

// Published words, cached so the dictionary has them offline too.
const PUB = 'mog.published';
export const published = {
  cached() { try { return JSON.parse(localStorage.getItem(PUB)) || []; } catch { return []; } },
  async refresh() {
    if (!online()) return null;
    const { entries } = await api('/api/entries', { auth: false });
    try { localStorage.setItem(PUB, JSON.stringify(entries)); } catch { /* storage full */ }
    return entries;
  },
};
