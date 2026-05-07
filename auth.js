/**
 * auth.js — Shared authentication module for Runestonemmo.com
 * Uses Supabase Discord OAuth. Mirrors the app's role system exactly.
 * Include this script on every page that needs auth awareness.
 *
 * Usage:
 *   <script src="/auth.js"></script>
 *   Then call: await RSAuth.init()  — resolves with { session, user, role, isElevated }
 *   Or call:   RSAuth.requireLogin() — redirects to home if not logged in
 */

const RSAuth = (() => {
  const SUPABASE_URL  = 'https://ludkhakegqojxuglisks.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1ZGtoYWtlZ3Fvanh1Z2xpc2tzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTE2MjEsImV4cCI6MjA5MzUyNzYyMX0.V5_Mp7eHc-3rKFZLUGNM_iH57hpiGMvp4CBcH33R0rE';
  const SESSION_KEY   = 'rs_session';

  // ── Role helpers (mirrors AuthContext.tsx exactly) ──────────────────
  const ROLE_LABELS = {
    admin:           'Admin',
    staff:           'Staff',
    content_creator: 'Content Creator',
    builder:         'Builder',
    runestonemmo:    'RunestoneMMO',
    casual_player:   'Casual Player',
    player:          'Player',
  };

  function isElevated(role) {
    return role === 'staff' || role === 'admin';
  }

  function getRoleLabel(role) {
    return ROLE_LABELS[role] || 'Guest';
  }

  // ── Supabase HTTP helpers ────────────────────────────────────────────
  async function supaFetch(path, opts = {}) {
    const session = getStoredSession();
    const headers = {
      'apikey':        SUPABASE_ANON,
      'Authorization': session ? `Bearer ${session.access_token}` : `Bearer ${SUPABASE_ANON}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      ...(opts.headers || {}),
    };
    const res = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── Session storage ──────────────────────────────────────────────────
  function storeSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function getStoredSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      // Check expiry
      if (s.expires_at && Date.now() / 1000 > s.expires_at) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      return s;
    } catch { return null; }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  // ── Fetch role from player_profiles ─────────────────────────────────
  async function fetchRole(discordId) {
    try {
      const data = await supaFetch(
        `/rest/v1/player_profiles?select=role&discord_id=eq.${discordId}&limit=1`
      );
      return (data && data.length) ? (data[0].role || 'player') : 'player';
    } catch {
      return 'player';
    }
  }

  // ── Parse token from URL hash (callback) ────────────────────────────
  function parseHashTokens() {
    const hash = window.location.hash.substring(1);
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const access_token  = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    const expires_in    = parseInt(params.get('expires_in') || '3600', 10);
    const token_type    = params.get('token_type');
    if (!access_token) return null;
    return { access_token, refresh_token, expires_in, token_type,
             expires_at: Math.floor(Date.now() / 1000) + expires_in };
  }

  // ── Decode JWT to get Discord user info ──────────────────────────────
  function decodeJwt(token) {
    try {
      const payload = token.split('.')[1];
      return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch { return {}; }
  }

  // ── Discord OAuth login ──────────────────────────────────────────────
  function loginWithDiscord() {
    const redirectTo = encodeURIComponent(
      window.location.origin + '/auth/callback.html'
    );
    const url = `${SUPABASE_URL}/auth/v1/authorize?provider=discord&redirect_to=${redirectTo}`;
    window.location.href = url;
  }

  // ── Sign out ─────────────────────────────────────────────────────────
  async function signOut() {
    const session = getStoredSession();
    if (session) {
      try {
        await supaFetch('/auth/v1/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        });
      } catch { /* ignore */ }
    }
    clearSession();
    window.location.href = '/index.html';
  }

  // ── Main init ────────────────────────────────────────────────────────
  async function init() {
    const session = getStoredSession();
    if (!session) return { session: null, user: null, role: null, isElevated: false };

    const jwt     = decodeJwt(session.access_token);
    const userId  = jwt.sub || '';
    // Discord ID is stored in user_metadata.provider_id or sub
    const discordId = jwt.user_metadata?.provider_id || userId;

    const role = await fetchRole(discordId);
    const user = {
      id:         userId,
      discordId,
      email:      jwt.email || '',
      username:   jwt.user_metadata?.full_name || jwt.user_metadata?.name || 'Player',
      avatarUrl:  jwt.user_metadata?.avatar_url || null,
    };

    return { session, user, role, isElevated: isElevated(role), getRoleLabel: () => getRoleLabel(role) };
  }

  // ── Require login — call on protected pages ──────────────────────────
  async function requireLogin() {
    const auth = await init();
    if (!auth.session) {
      window.location.href = '/index.html?login=required&from=' +
        encodeURIComponent(window.location.pathname);
      return null;
    }
    return auth;
  }

  // ── Render nav user pill ─────────────────────────────────────────────
  // Call after init(). Injects a user pill into the nav topbar.
  function renderNavUser(auth) {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;

    // Remove any existing pill
    const existing = document.getElementById('rs-nav-user');
    if (existing) existing.remove();

    const pill = document.createElement('div');
    pill.id = 'rs-nav-user';
    pill.style.cssText = `
      display:flex;align-items:center;gap:8px;margin-left:auto;
      cursor:pointer;position:relative;
    `;

    if (auth && auth.session) {
      const label = getRoleLabel(auth.role);
      const badgeColor = isElevated(auth.role) ? '#c9a227' : 'rgba(255,255,255,0.35)';
      pill.innerHTML = `
        <div id="rs-user-menu-trigger" style="display:flex;align-items:center;gap:8px;" onclick="RSAuth._toggleUserMenu()">
          ${auth.user.avatarUrl
            ? `<img src="${auth.user.avatarUrl}" style="width:30px;height:30px;border-radius:50%;border:2px solid ${badgeColor};" alt="avatar">`
            : `<div style="width:30px;height:30px;border-radius:50%;background:#2a2318;border:2px solid ${badgeColor};display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:${badgeColor};">⚔</div>`
          }
          <div style="display:flex;flex-direction:column;line-height:1.2;">
            <span style="font-size:0.78rem;color:#f0e6c8;font-weight:600;">${auth.user.username}</span>
            <span style="font-size:0.65rem;color:${badgeColor};text-transform:uppercase;letter-spacing:0.5px;font-family:'Cinzel',serif;">${label}</span>
          </div>
          <span style="color:rgba(255,255,255,0.4);font-size:0.7rem;">▾</span>
        </div>
        <div id="rs-user-dropdown" style="
          display:none;position:absolute;top:calc(100% + 8px);right:0;
          background:#1e1b17;border:1px solid #4a3a28;border-radius:8px;
          min-width:160px;z-index:1000;overflow:hidden;
        ">
          <a href="/account.html" style="display:block;padding:10px 16px;font-size:0.85rem;color:#f0e6c8;text-decoration:none;border-bottom:1px solid #4a3a28;">
            ⚙ Account
          </a>
          <button onclick="RSAuth.signOut()" style="
            width:100%;text-align:left;padding:10px 16px;font-size:0.85rem;
            color:#e57373;background:none;border:none;cursor:pointer;
          ">⬡ Sign Out</button>
        </div>
      `;
    } else {
      pill.innerHTML = `
        <button onclick="RSAuth.loginWithDiscord()" style="
          padding:7px 16px;background:#5865F2;color:#fff;border:none;
          border-radius:6px;font-size:0.82rem;font-weight:600;cursor:pointer;
          font-family:'Cinzel',serif;letter-spacing:0.5px;
          transition:background 0.15s;
        " onmouseover="this.style.background='#4752c4'" onmouseout="this.style.background='#5865F2'">
          Login with Discord
        </button>
      `;
    }

    topbar.appendChild(pill);
  }

  function _toggleUserMenu() {
    const dd = document.getElementById('rs-user-dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  }

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    const trigger = document.getElementById('rs-user-menu-trigger');
    const dd = document.getElementById('rs-user-dropdown');
    if (dd && trigger && !trigger.contains(e.target)) {
      dd.style.display = 'none';
    }
  });

  return {
    init,
    requireLogin,
    loginWithDiscord,
    signOut,
    storeSession,
    getStoredSession,
    parseHashTokens,
    renderNavUser,
    isElevated,
    getRoleLabel,
    _toggleUserMenu,
  };
})();
