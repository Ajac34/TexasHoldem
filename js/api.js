'use strict';
/* 与后端（server/server.js）通信。
 * 没有后端时（双击 index.html、或用 tools/serve.ps1 局域网服务器）一切照旧，只用本机存储；
 * 有后端时：虚拟玩家数据库以服务器为准；登录后职业存档、复盘手牌、HUD 统计同步到账号。 */

const Backend = {
  online: false, info: null, user: null, token: null, careerRev: null, ready: null,
  timers: {}, muted: 0,

  async init() {
    if (!/^https?:$/.test(location.protocol) || location.hash.startsWith('#smoke')) return;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (j && j.server === 'node') { this.online = true; this.info = j; } }
    } catch (e) { /* 没有后端 */ }
    if (!this.online) return;
    const tab = document.querySelector('[data-ltab="lan"]'); if (tab) tab.textContent = '联机对战';
    try { this.token = localStorage.getItem('thsim_token'); } catch (e) { this.token = null; }
    this.installHooks();
    await this.loadPlayers();
    if (this.token) await this.loadMe(false);
    this.renderAcct();
  },

  async api(method, url, body, opts = {}) {
    const headers = {};
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', keepalive: !!opts.keepalive });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (r.status === 401 && this.token && !url.startsWith('/api/auth/')) { this.dropSession(); }
    if (!r.ok && !(opts.allow || []).includes(r.status)) throw Object.assign(new Error((j && j.error) || ('HTTP ' + r.status)), { status: r.status, data: j });
    return Object.assign(j || {}, { _status: r.status });
  },

  /* 在不触发上传钩子的情况下写本机存储 */
  quiet(fn) { this.muted++; try { fn(); } finally { this.muted--; } },

  async loadPlayers() {
    try {
      const j = await this.api('GET', '/api/players');
      if (!j.players || !j.players.length) return;
      this.quiet(() => { PlayerDB.data = { version: j.version, epoch: j.epoch, players: j.players }; PlayerDB.save(); });
    } catch (e) { console.warn('加载玩家数据库失败', e); }
  },

  /* 登录后：服务器上有存档就用服务器的；服务器为空而本机有，则把本机存档上传到账号 */
  async loadMe(fresh) {
    try {
      const j = await this.api('GET', '/api/me');
      this.user = j.user; this.careerRev = j.careerRev;
      if (j.career) {
        this.quiet(() => { Career.p = j.career; Career.save(); });
      } else if (Career.p && fresh) {
        await this.pushCareer();
      } else if (!fresh) {
        this.quiet(() => Career.reset());
      }
      const h = await this.api('GET', '/api/me/hands');
      if (h.hands && h.hands.length) this.quiet(() => HandStore.saveAll(h.hands));
      else if (fresh && HandStore.list().length) this.schedule('hands', 100);
      else if (!fresh) this.quiet(() => HandStore.saveAll([]));
      await this.loadPlayers();
    } catch (e) {
      if (e.status === 401) this.dropSession();
      else console.warn('加载账号数据失败', e);
    }
  },

  dropSession() {
    this.token = null; this.user = null; this.careerRev = null;
    try { localStorage.removeItem('thsim_token'); } catch (e) { /* ignore */ }
    this.renderAcct();
  },

  async logout() {
    this.flush();
    try { await this.api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
    this.dropSession();
    // 本机清掉账号数据，避免下一个人看到
    this.quiet(() => { Career.reset(); HandStore.saveAll([]); });
    await this.loadPlayers();
    if (typeof Lobby !== 'undefined') Lobby.refresh();
  },

  /* ---------- 上传（防抖） ---------- */
  installHooks() {
    const wrap = (obj, name, after) => {
      const orig = obj[name].bind(obj);
      obj[name] = (...a) => { const r = orig(...a); if (!this.muted) after(); return r; };
    };
    wrap(Career, 'save', () => this.schedule('career', 1200));
    wrap(Career, 'reset', () => this.schedule('career', 50));
    wrap(HandStore, 'saveAll', () => this.schedule('hands', 3000));
    wrap(PlayerDB, 'save', () => this.schedule('pstats', 5000));
    const bye = () => this.flush(true);
    window.addEventListener('pagehide', bye);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') bye(); });
  },
  schedule(kind, ms) {
    if (!this.user) return;
    clearTimeout(this.timers[kind]);
    this.timers[kind] = setTimeout(() => { delete this.timers[kind]; this.push(kind); }, ms);
  },
  flush(keepalive) {
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); delete this.timers[k]; this.push(k, keepalive); }
  },
  push(kind, keepalive) {
    if (!this.user) return;
    if (kind === 'career') this.pushCareer(keepalive);
    else if (kind === 'hands') this.api('PUT', '/api/me/hands', { hands: HandStore.list() }).catch((e) => console.warn(e));
    else if (kind === 'pstats') this.pushPlayerStats(keepalive);
  },
  async pushCareer(keepalive) {
    try {
      const j = await this.api('PUT', '/api/me/career', { career: Career.p, rev: this.careerRev }, { allow: [409], keepalive });
      if (j._status === 409) {
        // 管理员改过存档（或另一台设备更新过）：以服务器版本为准
        this.careerRev = j.careerRev;
        this.quiet(() => { Career.p = j.career; Career.save(); });
        if (typeof Lobby !== 'undefined' && !$('lobby').classList.contains('hidden')) Lobby.refresh();
        if (typeof addLog === 'function' && S.game) addLog('（职业存档已按服务器版本更新）', 'sys');
      } else this.careerRev = j.careerRev;
    } catch (e) { console.warn('同步职业存档失败', e); }
  },
  async pushPlayerStats(keepalive) {
    const d = PlayerDB.data; if (!d || !d.epoch) return;
    const players = {};
    for (const p of d.players) {
      if (p.handsWithHero || p.stats || p.notes) players[p.id] = { stats: p.stats, handsWithHero: p.handsWithHero || 0, sessionsWithHero: p.sessionsWithHero || 0, notes: p.notes || '' };
    }
    try {
      const j = await this.api('PUT', '/api/me/playerstats', { epoch: d.epoch, players }, { allow: [409], keepalive });
      if (j._status === 409) await this.loadPlayers();   // 管理员重建了数据库
    } catch (e) { console.warn('同步 HUD 统计失败', e); }
  },

  /* ---------- 账号界面 ---------- */
  renderAcct() {
    const box = $('acct-box'); if (!box) return;
    if (!this.online) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (this.user) {
      box.innerHTML = `<span class="acct-name">👤 <b>${esc(this.user.name)}</b> · 已同步</span> <button id="acct-out">退出</button>`;
      $('acct-out').onclick = async () => {
        const c = await showModal('<h3>退出登录？</h3><p>存档已保存在服务器，下次登录即可恢复。本机会清除这个账号的数据。</p>', [{ label: '取消', value: 'no' }, { label: '退出', value: 'yes', primary: true }]);
        if (c === 'yes') this.logout();
      };
    } else {
      box.innerHTML = '<button id="acct-in" class="primary">登录 / 注册</button>';
      $('acct-in').onclick = () => this.loginDialog();
    }
  },

  async loginDialog(msg) {
    const html = `<h3>登录 / 注册</h3><p class="note">登录后，职业存档、复盘手牌和对手 HUD 数据会保存在服务器，换设备也能继续。</p>
      ${msg ? `<p class="neg">${esc(msg)}</p>` : ''}
      <div class="opts"><label>用户名 <input id="acct-u" maxlength="16" autocomplete="username" style="width:180px"></label>
      <label>密码 <input id="acct-p" type="password" maxlength="72" autocomplete="current-password" style="width:180px"></label></div>`;
    const p = showModal(html, [{ label: '取消', value: 'no' }, { label: '注册新账号', value: 'reg' }, { label: '登录', value: 'login', primary: true }]);
    setTimeout(() => { const u = $('acct-u'); if (u) u.focus(); }, 30);
    const c = await p;
    if (c === 'no') return;
    const name = $('acct-u').value.trim(), password = $('acct-p').value;
    try {
      const j = await this.api('POST', c === 'reg' ? '/api/auth/register' : '/api/auth/login', { name, password });
      this.token = j.token; this.user = j.user;
      try { localStorage.setItem('thsim_token', j.token); } catch (e) { /* ignore */ }
      await this.loadMe(true);
      this.renderAcct();
      if (typeof Lobby !== 'undefined') Lobby.refresh();
    } catch (e) {
      this.loginDialog(e.message);
    }
  },
};

window.addEventListener('DOMContentLoaded', () => {
  // 等界面初始化（ui.js 里 30ms 后才建大厅）之后再连后端
  Backend.ready = new Promise((res) => setTimeout(() => Backend.init().then(() => {
    if (Backend.online && typeof Lobby !== 'undefined' && !$('lobby').classList.contains('hidden')) Lobby.refresh();
    res();
  }, res), 60));
});
