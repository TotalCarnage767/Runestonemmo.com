/**
 * auth.js — RunestoneMMO Website Auth Module v3
 *
 * Primary login: Discord OAuth via Supabase Auth
 *   - Persistent sessions: refresh_token stored, auto-refreshed on every page load
 *   - Sessions last until the user explicitly logs out (no re-login every hour)
 *   - Token is silently refreshed if it expires while the user is browsing
 *
 * Secondary (optional): Minecraft /rlink
 *   - Available on account.html only
 *   - Links Minecraft UUID to Discord account
 *   - Unlocks Character Sheet, Dashboard, player stats
 *
 * Gate: visibility:hidden by default — zero flash on logged-in pages.
 */
const RSAuth = (() => {
  const SUPA_URL  = 'https://ludkhakegqojxuglisks.supabase.co';
  const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1ZGtoYWtlZ3Fvanh1Z2xpc2tzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTE2MjEsImV4cCI6MjA5MzUyNzYyMX0.V5_Mp7eHc-3rKFZLUGNM_iH57hpiGMvp4CBcH33R0rE';
  const SESSION_KEY = 'sb-session';
  const ROLE_KEY    = 'rs-role';
  const MC_LINK_KEY = 'rs-mc-link'; // { username, uuid, linked_at } — 30-day TTL
  const MC_LINK_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
  // Refresh token if it expires within 5 minutes
  const REFRESH_BUFFER_SECS = 300;

  const ELEVATED_ROLES = ['admin', 'staff', 'runestonemmo'];
  const ROLE_LABELS = {
    admin:           'Admin',
    staff:           'Staff',
    content_creator: 'Content Creator',
    builder:         'Builder',
    runestonemmo:    'RunestoneMMO',
    casual_player:   'Casual Player',
    player:          'Player',
  };
  const ROLE_COLORS = {
    admin:           '#ff6b6b',
    staff:           '#6ab0f5',
    content_creator: '#4ade80',
    builder:         '#a78bfa',
    runestonemmo:    '#fb923c',
    casual_player:   '#c9a227',
    player:          '#c9a227',
  };

  // ── Minecraft link cache (30-day localStorage persistence) ───────────────────
  function getMcLink() {
    try {
      const raw = localStorage.getItem(MC_LINK_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj.linked_at && (Date.now() - obj.linked_at) > MC_LINK_TTL) {
        localStorage.removeItem(MC_LINK_KEY);
        return null;
      }
      return obj; // { username, uuid, linked_at }
    } catch { return null; }
  }
  function setMcLink(username, uuid) {
    try {
      localStorage.setItem(MC_LINK_KEY, JSON.stringify({
        username:  username,
        uuid:      uuid,
        linked_at: Date.now(),
      }));
    } catch {}
  }
  function clearMcLink() {
    localStorage.removeItem(MC_LINK_KEY);
  }

  // ── Supabase REST helper ──────────────────────────────────────────────────
  async function supaFetch(path, opts, token) {
    opts = opts || {};
    const res = await fetch(SUPA_URL + path, Object.assign({}, opts, {
      headers: Object.assign({
        'apikey':        SUPA_ANON,
        'Authorization': 'Bearer ' + (token || SUPA_ANON),
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      }, opts.headers || {}),
    }));
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'HTTP ' + res.status);
    }
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  // ── Raw session storage ───────────────────────────────────────────────────
  function _readRaw() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _writeRaw(obj) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(obj));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ROLE_KEY);
  }

  // ── Token refresh ─────────────────────────────────────────────────────────
  // Calls Supabase /auth/v1/token?grant_type=refresh_token
  // Returns the new session object or null on failure
  async function _refreshToken(refreshToken) {
    try {
      const res = await fetch(SUPA_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: {
          'apikey':       SUPA_ANON,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.access_token) return null;
      return data;
    } catch { return null; }
  }

  // ── getSupabaseSession — always returns a valid (possibly refreshed) session ──
  // This is async because it may need to refresh the token.
  // For synchronous callers (requireLogin), use _getSessionSync which skips refresh.
  async function getSupabaseSession() {
    const raw = _readRaw();
    if (!raw || !raw.access_token) return null;

    const nowSecs = Date.now() / 1000;
    const expiresAt = raw.expires_at || 0;

    // Token is still valid — return as-is
    if (expiresAt - nowSecs > REFRESH_BUFFER_SECS) return raw;

    // Token is expired or about to expire — try to refresh
    if (!raw.refresh_token) {
      clearSession();
      return null;
    }

    const refreshed = await _refreshToken(raw.refresh_token);
    if (!refreshed) {
      // Refresh failed — clear session so user sees login gate
      clearSession();
      return null;
    }

    // Merge user object from old session if not returned by refresh
    if (!refreshed.user && raw.user) refreshed.user = raw.user;

    _writeRaw(refreshed);

    // Re-fetch role with new token
    if (refreshed.user && refreshed.user.id) {
      await fetchAndCacheRole(refreshed.access_token, refreshed.user.id);
    }

    return refreshed;
  }

  // Synchronous version — does NOT refresh, used for immediate checks
  function _getSessionSync() {
    const raw = _readRaw();
    if (!raw || !raw.access_token) return null;
    // If expired AND no refresh token, clear it
    const nowSecs = Date.now() / 1000;
    if (raw.expires_at && nowSecs > raw.expires_at && !raw.refresh_token) {
      clearSession();
      return null;
    }
    return raw;
  }

  // ── getSession — display object for nav pill + gate check ─────────────────
  // Synchronous — uses cached session. Call initSession() first on page load.
  function getSession() {
    const s = _getSessionSync();
    if (!s) return null;
    const user = s.user || {};
    const meta = user.user_metadata || {};
    const username = meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : 'Player');
    const role = localStorage.getItem(ROLE_KEY) || 'player';
    return {
      username:     username,
      role:         role,
      isElevated:   ELEVATED_ROLES.includes(role),
      access_token: s.access_token,
      user_id:      user.id,
      discord_id:   meta.provider_id || user.id,
      email:        user.email,
    };
  }

  // ── initSession — call once on page load to silently refresh if needed ────
  // Returns the display session (or null if not logged in).
  // After this resolves, getSession() is safe to call synchronously.
  async function initSession() {
    const s = await getSupabaseSession();
    if (!s) return null;
    const user = s.user || {};
    const meta = user.user_metadata || {};
    const username = meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : 'Player');
    const role = localStorage.getItem(ROLE_KEY) || 'player';
    return {
      username:     username,
      role:         role,
      isElevated:   ELEVATED_ROLES.includes(role),
      access_token: s.access_token,
      user_id:      user.id,
      discord_id:   meta.provider_id || user.id,
      email:        user.email,
    };
  }

  // ── Fetch and cache role from user_roles table ────────────────────────────
  async function fetchAndCacheRole(accessToken, userId) {
    try {
      const rows = await supaFetch(
        '/rest/v1/user_roles?select=role&user_id=eq.' + userId + '&limit=1',
        {}, accessToken
      );
      const role = (rows && rows.length > 0 && rows[0].role) ? rows[0].role : 'player';
      localStorage.setItem(ROLE_KEY, role);
      return role;
    } catch {
      if (!localStorage.getItem(ROLE_KEY)) localStorage.setItem(ROLE_KEY, 'player');
      return localStorage.getItem(ROLE_KEY) || 'player';
    }
  }

  // ── Discord OAuth login ───────────────────────────────────────────────────
  function loginWithDiscord() {
    const redirectTo = encodeURIComponent(window.location.origin + '/auth/callback.html');
    window.location.href = SUPA_URL + '/auth/v1/authorize?provider=discord&redirect_to=' + redirectTo;
  }

  // ── Handle OAuth callback (called from auth/callback.html) ───────────────
  async function handleCallback() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const accessToken  = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const expiresAt    = params.get('expires_at');
    const expiresIn    = params.get('expires_in');

    if (!accessToken) {
      window.location.href = '/index.html';
      return;
    }

    const sessionObj = {
      access_token:  accessToken,
      refresh_token: refreshToken,
      expires_at:    expiresAt ? parseInt(expiresAt) : (Date.now() / 1000 + parseInt(expiresIn || '3600')),
      user: null,
    };

    // Fetch user info
    try {
      const userRes = await fetch(SUPA_URL + '/auth/v1/user', {
        headers: { 'apikey': SUPA_ANON, 'Authorization': 'Bearer ' + accessToken },
      });
      if (userRes.ok) sessionObj.user = await userRes.json();
    } catch {}

    _writeRaw(sessionObj);

    if (sessionObj.user && sessionObj.user.id) {
      await fetchAndCacheRole(accessToken, sessionObj.user.id);
    }

    const returnTo = sessionStorage.getItem('rs-return-to') || '/index.html';
    sessionStorage.removeItem('rs-return-to');
    window.location.href = returnTo;
  }

  // ── requireLogin — async, refreshes token before deciding ─────────────────
  // Returns session if logged in, null if not (and shows gate).
  async function requireLogin() {
    const session = await initSession();
    if (session) return session;
    sessionStorage.setItem('rs-return-to', window.location.pathname + window.location.search);
    const gate = document.getElementById('rs-login-gate');
    if (gate) {
      gate.style.visibility  = 'visible';
      gate.style.opacity     = '1';
      gate.style.pointerEvents = 'all';
    }
    document.body.style.overflow = 'hidden';
    return null;
  }

  // ── renderNavUser ─────────────────────────────────────────────────────────
  function renderNavUser(session) {
    const slot = document.getElementById('navUserSlot');
    if (!slot) return;
    if (!session) {
      slot.innerHTML = `
        <button onclick="RSAuth.loginWithDiscord()" style="
          display:flex;align-items:center;gap:7px;
          padding:7px 14px;
          background:rgba(88,101,242,0.15);
          color:#7289da;
          border:1px solid rgba(88,101,242,0.4);
          border-radius:6px;font-size:0.8rem;font-weight:700;
          cursor:pointer;font-family:'Cinzel',serif;
          letter-spacing:0.5px;white-space:nowrap;
        ">
          <svg width="16" height="12" viewBox="0 0 71 55" fill="#7289da" xmlns="http://www.w3.org/2000/svg">
            <path d="M60.1 4.9A58.5 58.5 0 0 0 45.5.4a40.7 40.7 0 0 0-1.8 3.7 54 54 0 0 0-16.3 0A39.6 39.6 0 0 0 25.6.4 58.4 58.4 0 0 0 11 4.9C1.6 19.1-.9 33 .3 46.6a58.9 58.9 0 0 0 18 9.1 44.6 44.6 0 0 0 3.8-6.2 38.3 38.3 0 0 1-6-2.9l1.5-1.1a42 42 0 0 0 36 0l1.5 1.1a38.2 38.2 0 0 1-6 2.9 44.4 44.4 0 0 0 3.8 6.2 58.7 58.7 0 0 0 18-9.1c1.5-15.5-2.5-29.3-10.8-41.6ZM23.7 38.2c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2c3.5 0 6.4 3.2 6.3 7.2 0 4-2.8 7.2-6.3 7.2Zm23.6 0c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2c3.5 0 6.4 3.2 6.3 7.2 0 4-2.8 7.2-6.3 7.2Z"/>
          </svg>
          Login with Discord
        </button>`;
      return;
    }
    const color = ROLE_COLORS[session.role] || '#c9a227';
    const label = ROLE_LABELS[session.role] || 'Player';
    const initial = (session.username || '?').charAt(0).toUpperCase();
    slot.innerHTML = `
      <div style="position:relative;display:inline-block;">
        <div id="rs-user-trigger" onclick="RSAuth._toggleMenu()" style="
          display:flex;align-items:center;gap:8px;
          background:#2a2318;border:1px solid #4a3a28;border-radius:20px;
          padding:4px 12px 4px 6px;cursor:pointer;
        ">
          <div style="
            width:28px;height:28px;border-radius:50%;
            background:#3d2e1e;border:2px solid ${color};
            display:flex;align-items:center;justify-content:center;
            font-size:0.75rem;font-weight:700;color:${color};
            font-family:'Cinzel',serif;flex-shrink:0;
          ">${initial}</div>
          <div>
            <div style="font-size:0.78rem;color:#f0e6c8;font-weight:700;font-family:'Cinzel',serif;line-height:1.1;">${esc(session.username)}</div>
            <div style="font-size:0.62rem;color:${color};text-transform:uppercase;letter-spacing:0.4px;">${label}</div>
          </div>
          <span style="color:rgba(255,255,255,0.35);font-size:0.65rem;margin-left:2px;">▾</span>
        </div>
        <div id="rs-user-dropdown" style="
          display:none;position:absolute;top:calc(100% + 8px);right:0;
          background:#1e1b17;border:1px solid #4a3a28;border-radius:10px;
          min-width:160px;z-index:2000;overflow:hidden;
          box-shadow:0 8px 24px rgba(0,0,0,0.5);
        ">
          <a href="/account.html" style="
            display:block;padding:11px 16px;font-size:0.85rem;
            color:#f0e6c8;text-decoration:none;border-bottom:1px solid #4a3a28;
            font-family:'Cinzel',serif;
          ">⚙ Account</a>
          ${ELEVATED_ROLES.includes(session.role) ? `<a href="/admin-panel.html" style="
            display:block;padding:11px 16px;font-size:0.85rem;
            color:#ff6b6b;text-decoration:none;border-bottom:1px solid #4a3a28;
            font-family:'Cinzel',serif;
          ">⚑ Admin Panel</a>` : ''}
          <button onclick="RSAuth.logout()" style="
            width:100%;text-align:left;padding:11px 16px;font-size:0.85rem;
            color:#e57373;background:none;border:none;cursor:pointer;
            font-family:'Cinzel',serif;
          ">⬡ Logout</button>
        </div>
      </div>`;
  }

  function _toggleMenu() {
    const dd = document.getElementById('rs-user-dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  }

  document.addEventListener('click', function(e) {
    const trigger = document.getElementById('rs-user-trigger');
    const dd = document.getElementById('rs-user-dropdown');
    if (dd && dd.style.display === 'block' && trigger && !trigger.contains(e.target)) {
      dd.style.display = 'none';
    }
  });

  // Auto-refresh when user returns to tab
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      getSupabaseSession(); // silently refreshes if needed
    }
  });

  function showLoginModal() {
    const gate = document.getElementById('rs-login-gate');
    if (gate) { gate.style.visibility = 'visible'; gate.style.opacity = '1'; gate.style.pointerEvents = 'all'; }
    document.body.style.overflow = 'hidden';
  }

  function hideLoginModal() {
    const gate = document.getElementById('rs-login-gate');
    if (gate) { gate.style.visibility = 'hidden'; gate.style.opacity = '0'; gate.style.pointerEvents = 'none'; }
    document.body.style.overflow = '';
  }

  async function logout() {
    const s = _getSessionSync();
    if (s && s.access_token) {
      try {
        await fetch(SUPA_URL + '/auth/v1/logout', {
          method: 'POST',
          headers: { 'apikey': SUPA_ANON, 'Authorization': 'Bearer ' + s.access_token },
        });
      } catch {}
    }
    clearSession();
    clearMcLink();
    window.location.href = '/index.html';
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return {
    getSession,
    getSupabaseSession,
    initSession,
    requireLogin,
    renderNavUser,
    loginWithDiscord,
    handleCallback,
    fetchAndCacheRole,
    getMcLink,
    setMcLink,
    clearMcLink,
    logout,
    showLoginModal,
    hideLoginModal,
    _toggleMenu,
    supaFetch,
    esc,
  };
})();
