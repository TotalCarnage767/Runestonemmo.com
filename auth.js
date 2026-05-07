/**
 * auth.js — RunestoneMMO Website Auth Module v2
 *
 * Login flow (Minecraft /rlink — no Discord OAuth):
 *   1. Player types /rlink in-game → plugin writes a 6-char code to account_link_codes
 *   2. Player enters the code on the website
 *   3. We look up the code in Supabase (unused, not expired)
 *   4. We fetch their player_profiles row to get username + role
 *   5. We store {uuid, username, role, isElevated} in localStorage as the session
 *   6. We mark the code as used
 *
 * Gate fix: gate starts visibility:hidden so there is ZERO flash on logged-in pages.
 * It only becomes visible if requireLogin() finds no session.
 */

const RSAuth = (() => {
  const SUPA_URL  = 'https://ludkhakegqojxuglisks.supabase.co';
  const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1ZGtoYWtlZ3Fvanh1Z2xpc2tzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5NTE2MjEsImV4cCI6MjA5MzUyNzYyMX0.V5_Mp7eHc-3rKFZLUGNM_iH57hpiGMvp4CBcH33R0rE';
  const SESSION_KEY = 'rs_mc_session';
  const ELEVATED_ROLES = ['admin', 'staff', 'runestonemmo'];

  const ROLE_LABELS = {
    admin:           'Admin',
    staff:           'Staff',
    content_creator: 'Content Creator',
    builder:         'Builder',
    runestonemmo:    'RunestoneMMO',
    player:          'Player',
  };

  const ROLE_COLORS = {
    admin:           '#ff6b6b',
    staff:           '#6ab0f5',
    content_creator: '#4ade80',
    builder:         '#a78bfa',
    runestonemmo:    '#fb923c',
    player:          '#c9a227',
  };

  // ── Supabase REST helper ──────────────────────────────────────────────────
  async function supaFetch(path, opts = {}) {
    const res = await fetch(SUPA_URL + path, {
      ...opts,
      headers: {
        'apikey':        SUPA_ANON,
        'Authorization': `Bearer ${SUPA_ANON}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  // ── Session helpers ───────────────────────────────────────────────────────
  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.uuid || !s.username) return null;
      if (s.expires_at && Date.now() > s.expires_at) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      return s;
    } catch { return null; }
  }

  function saveSession(uuid, username, role) {
    const s = {
      uuid,
      username,
      role: role || 'player',
      isElevated: ELEVATED_ROLES.includes(role),
      expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    return s;
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  // ── Verify /rlink code ────────────────────────────────────────────────────
  async function verifyCode(rawCode) {
    const code = rawCode.trim().toUpperCase();
    if (code.length !== 6) throw new Error('Code must be exactly 6 characters.');

    const rows = await supaFetch(
      `/rest/v1/account_link_codes?select=*&code=eq.${code}&used=eq.false&expires_at=gt.${new Date().toISOString()}&limit=1`
    );
    if (!rows || rows.length === 0) {
      throw new Error('Code not found or expired. Type /rlink in-game to get a new code.');
    }
    const linkRow = rows[0];

    let role = 'player';
    try {
      const profiles = await supaFetch(
        `/rest/v1/player_profiles?select=role&uuid=eq.${linkRow.uuid}&limit=1`
      );
      if (profiles && profiles.length > 0 && profiles[0].role) {
        role = profiles[0].role;
      }
    } catch { /* role stays as player */ }

    // Mark code used (non-fatal)
    try {
      await supaFetch(`/rest/v1/account_link_codes?id=eq.${linkRow.id}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ used: true }),
      });
    } catch { /* non-fatal */ }

    return saveSession(linkRow.uuid, linkRow.username, role);
  }

  // ── requireLogin ──────────────────────────────────────────────────────────
  // Call at the top of every protected page.
  // Returns the session immediately if logged in (no flash).
  // Shows the login gate only if there is genuinely no session.
  function requireLogin() {
    const session = getSession();
    if (session) return session;
    // Show gate — use visibility + opacity so the gate was never painted visible
    const gate = document.getElementById('rs-login-gate');
    if (gate) {
      gate.style.visibility = 'visible';
      gate.style.opacity    = '1';
      gate.style.pointerEvents = 'all';
    }
    document.body.style.overflow = 'hidden';
    return null;
  }

  // ── renderNavUser ─────────────────────────────────────────────────────────
  // Injects the user pill into #navUserSlot (must exist in the topbar HTML)
  function renderNavUser(session) {
    const slot = document.getElementById('navUserSlot');
    if (!slot) return;

    if (!session) {
      // Show login button
      slot.innerHTML = `
        <button
          onclick="RSAuth.showLoginModal()"
          style="
            padding:7px 16px;
            background:rgba(201,162,39,0.12);
            color:#c9a227;
            border:1px solid rgba(201,162,39,0.35);
            border-radius:6px;
            font-size:0.8rem;
            font-weight:700;
            cursor:pointer;
            font-family:'Cinzel',serif;
            letter-spacing:0.5px;
            white-space:nowrap;
          "
        >⚔ Login</button>
      `;
      return;
    }

    const color = ROLE_COLORS[session.role] || '#c9a227';
    const label = ROLE_LABELS[session.role] || 'Player';
    const initial = (session.username || '?').charAt(0).toUpperCase();

    slot.innerHTML = `
      <div style="position:relative;display:inline-block;">
        <div
          id="rs-user-trigger"
          onclick="RSAuth._toggleMenu()"
          style="
            display:flex;align-items:center;gap:8px;
            background:#2a2318;border:1px solid #4a3a28;border-radius:20px;
            padding:4px 12px 4px 6px;cursor:pointer;
          "
        >
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
          <button onclick="RSAuth.logout()" style="
            width:100%;text-align:left;padding:11px 16px;font-size:0.85rem;
            color:#e57373;background:none;border:none;cursor:pointer;
            font-family:'Cinzel',serif;
          ">⬡ Logout</button>
        </div>
      </div>
    `;
  }

  function _toggleMenu() {
    const dd = document.getElementById('rs-user-dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  }

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    const trigger = document.getElementById('rs-user-trigger');
    const dd = document.getElementById('rs-user-dropdown');
    if (dd && dd.style.display === 'block' && trigger && !trigger.contains(e.target)) {
      dd.style.display = 'none';
    }
  });

  // ── showLoginModal ────────────────────────────────────────────────────────
  function showLoginModal() {
    const gate = document.getElementById('rs-login-gate');
    if (gate) {
      gate.style.visibility = 'visible';
      gate.style.opacity    = '1';
      gate.style.pointerEvents = 'all';
    }
    document.body.style.overflow = 'hidden';
  }

  function hideLoginModal() {
    const gate = document.getElementById('rs-login-gate');
    if (gate) {
      gate.style.visibility = 'hidden';
      gate.style.opacity    = '0';
      gate.style.pointerEvents = 'none';
    }
    document.body.style.overflow = '';
  }

  // ── logout ────────────────────────────────────────────────────────────────
  function logout() {
    clearSession();
    window.location.href = '/index.html';
  }

  // ── Util ──────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return {
    getSession,
    requireLogin,
    renderNavUser,
    verifyCode,
    logout,
    showLoginModal,
    hideLoginModal,
    _toggleMenu,
  };
})();
