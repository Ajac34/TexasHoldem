'use strict';
/* 大厅：职业生涯（资金/级别/锦标赛）、玩家数据库、复盘列表 */

const Lobby = {
  tab: 'career',
  dbFilter: { persona: '', level: '', sort: 'level' },

  init() {
    document.querySelectorAll('#lobby-tabs button').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.ltab)));
    const fc = $('opt-4color');
    try { const v = localStorage.getItem('thsim_4color'); if (v != null) fc.checked = v === '1'; } catch (e) { /* ignore */ }
    const apply = () => { document.body.classList.toggle('four-color', fc.checked); try { localStorage.setItem('thsim_4color', fc.checked ? '1' : '0'); } catch (e) { /* ignore */ } };
    fc.addEventListener('change', apply); apply();
    PlayerDB.load();
    Career.load();
    this.refresh();
  },

  show(tab) {
    this.tab = tab;
    document.querySelectorAll('#lobby-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.ltab === tab));
    for (const k of ['career', 'db', 'review', 'practice', 'lan']) $('lt-' + k).classList.toggle('hidden', k !== tab);
    this.refresh();
  },

  refresh() {
    if (this.tab === 'career') this.renderCareer();
    else if (this.tab === 'db') this.renderDB();
    else if (this.tab === 'review') this.renderReviewList();
    else if (this.tab === 'lan') NetUI.render();
  },

  /* ---------------- 职业生涯 ---------------- */
  renderCareer() {
    const el = $('lt-career');
    const p = Career.p;
    if (!p) {
      el.innerHTML = `<div class="panel" style="max-width:640px">
        <h2>开始你的职业生涯</h2>
        <p class="sub">你有一笔起始资金（bankroll）。现金桌买入、锦标赛报名都从资金里扣，离桌时剩余筹码退回。
        <b>资金低于最低买入（$${MIN_ENTRY}）即破产，职业生涯结束。</b>级别越高，对手中的高手越多。</p>
        <div class="opts">
          <label>昵称 <input id="cr-name" value="你" maxlength="12" style="width:200px"></label>
          <label>起始资金
            <select id="cr-start">
              <option value="2000">$2,000（困难：只够在新手桌磨）</option>
              <option value="5000" selected>$5,000（标准）</option>
              <option value="20000">$20,000（宽松）</option>
            </select>
          </label>
        </div>
        <div class="lobby-actions"><button id="cr-go" class="primary big">开始</button></div></div>`;
      $('cr-go').onclick = () => { Career.create($('cr-name').value.trim() || '你', +$('cr-start').value); this.refresh(); };
      return;
    }
    Career.checkOver();
    if (p.over) {
      const peak = p.peak, days = Math.max(1, Math.round((Date.now() - p.created) / 86400000));
      el.innerHTML = `<div class="panel" style="max-width:700px">
        <h2 style="color:#ff8a80">破产 —— 职业生涯结束</h2>
        <p>剩余资金 <b>$${fmt(p.bankroll)}</b> 已不足最低买入（$${MIN_ENTRY}）。</p>
        <div class="kv"><div>起始资金</div><div>$${fmt(p.start)}</div><div>最高资金</div><div>$${fmt(peak)}</div>
        <div>总手数</div><div>${fmt(p.hands)}</div><div>持续</div><div>${days} 天</div>
        <div>锦标赛</div><div>${p.tourResults.length} 场，进钱 ${p.tourResults.filter((r) => r.prize > 0).length} 次</div></div>
        <p class="note">复盘一下：是不是在资金只有十几个买入时就上了高级别？连输时有没有止损？</p>
        <div class="lobby-actions"><button id="cr-restart" class="primary big">重新开始职业生涯</button></div></div>` + this.historyHTML();
      $('cr-restart').onclick = () => { Career.reset(); this.refresh(); };
      return;
    }
    const hs = PlayerStats.from(p.heroStats);
    const net = p.bankroll - p.start;
    let h = `<div class="panel"><div class="bank-card">
      <div>${avatarSVG(HERO_AVATAR, 72)}</div>
      <div><div class="note">${esc(p.name)} 的资金</div><div class="bank-big">$${fmt(p.bankroll)}</div>
        <div class="note">起始 $${fmt(p.start)} · 最高 $${fmt(p.peak)} · 总盈亏 <b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}$${fmt(net)}</b></div></div>
      <div class="kv" style="margin:0"><div>生涯手数</div><div>${fmt(p.hands)}</div>
        <div>VPIP / PFR</div><div>${fmtPct(hs.vpipPct)} / ${fmtPct(hs.pfrPct)}</div>
        <div>AF / WTSD</div><div>${hs.af == null ? '-' : hs.af.toFixed(1)} / ${fmtPct(hs.wtsdPct)}</div>
        <div>你的风格</div><div>${(() => { const mp = hs.mapPoint(6); return mp ? classifyStyle(mp.x, mp.y) : '数据不足'; })()}</div></div>
      </div>
      <p class="note">资金管理建议：现金桌至少 20–30 个满买入（100BB），锦标赛至少 30–50 个报名费。下面每个级别都标出了你的资金相当于多少个买入。</p></div>`;

    h += '<div class="panel" style="margin-top:14px"><h2>现金桌</h2><table class="data-table"><tr><th>级别</th><th>难度</th><th>盲注</th><th>买入范围</th><th>抽水</th><th>常见对手</th><th>资金管理</th><th></th></tr>';
    for (const s of CASH_STAKES) {
      const full = s.bb * 100;
      const brm = Career.brm(full, 'cash');
      const can = p.bankroll >= s.bb * MIN_BUYIN_BB;
      const mix = personaLevelMix(s.lv).slice(0, 4);
      h += `<tr><td><b>${s.name}</b></td><td class="stars">${'★'.repeat(s.lv)}<span style="opacity:.25">${'★'.repeat(6 - s.lv)}</span></td>
        <td>$${s.sb}/$${s.bb}</td><td>$${fmt(s.bb * MIN_BUYIN_BB)}–$${fmt(full)}</td><td>${Math.round(s.rakePct * 100)}%，封顶 ${s.rakeCapBB}BB</td>
        <td style="text-align:left">${mix.map(([k, w]) => `${PERSONAS[k].name} ${Math.round(w * 100)}%`).join('、')}</td>
        <td>${brm.n.toFixed(1)} 个 <span class="brm ${brm.level}">${brm.text}</span></td>
        <td><button data-cash="${s.lv}" ${can ? '' : 'disabled'}>${can ? '入座' : '资金不足'}</button></td></tr>`;
    }
    h += '</table></div>';

    h += '<div class="panel" style="margin-top:14px"><h2>锦标赛（单桌 SNG）</h2><table class="data-table"><tr><th>赛事</th><th>难度</th><th>报名费</th><th>人数</th><th>奖励</th><th>资金管理</th><th></th></tr>';
    for (const t of TOURS) {
      const cost = t.buyin + t.fee;
      const brm = Career.brm(cost, 'tour');
      const pool = t.buyin * t.size;
      h += `<tr><td><b>${t.name}</b></td><td class="stars">${'★'.repeat(t.lv)}<span style="opacity:.25">${'★'.repeat(6 - t.lv)}</span></td>
        <td>$${fmt(t.buyin)} + $${fmt(t.fee)}</td><td>${t.size} 人</td>
        <td>${payoutStructure(t.size).map((x, i) => `第${i + 1}名 $${fmt(x * pool)}`).join('，')}</td>
        <td>${brm.n.toFixed(1)} 个 <span class="brm ${brm.level}">${brm.text}</span></td>
        <td><button data-tour="${t.id}" ${p.bankroll >= cost ? '' : 'disabled'}>${p.bankroll >= cost ? '报名' : '资金不足'}</button></td></tr>`;
    }
    h += '</table></div>' + this.historyHTML();
    h += '<div class="row" style="margin-top:10px"><button id="cr-reset" style="opacity:.6">放弃并重新开始职业生涯</button></div>';
    el.innerHTML = h;
    el.querySelectorAll('[data-cash]').forEach((b) => b.onclick = () => this.sitCash(CASH_STAKES.find((s) => s.lv === +b.dataset.cash)));
    el.querySelectorAll('[data-tour]').forEach((b) => b.onclick = () => this.joinTour(TOURS.find((t) => t.id === b.dataset.tour)));
    $('cr-reset').onclick = async () => {
      const c = await showModal('<h3>确定放弃当前职业生涯？</h3><p>资金和生涯统计将被清空（玩家数据库与复盘记录保留）。</p>', [{ label: '取消', value: 'no', primary: true }, { label: '确定放弃', value: 'yes' }]);
      if (c === 'yes') { Career.reset(); this.refresh(); }
    };
  },

  historyHTML() {
    const p = Career.p;
    if (!p || !p.history.length) return '';
    let h = '<div class="panel" style="margin-top:14px"><h2>资金记录</h2><table class="data-table"><tr><th>时间</th><th>内容</th><th>盈亏</th><th>结余</th></tr>';
    for (const r of p.history.slice(0, 15)) {
      h += `<tr><td>${new Date(r.ts).toLocaleString()}</td><td style="text-align:left">${esc(r.desc)}</td>
        <td class="${r.net >= 0 ? 'pos' : 'neg'}">${r.net >= 0 ? '+' : ''}$${fmt(r.net)}</td><td>$${fmt(r.bankroll)}</td></tr>`;
    }
    return h + '</table></div>';
  },

  async sitCash(stake) {
    const p = Career.p;
    const minB = stake.bb * MIN_BUYIN_BB, maxB = Math.min(stake.bb * MAX_BUYIN_BB, Math.floor(p.bankroll / stake.bb) * stake.bb);
    const brm = Career.brm(stake.bb * 100, 'cash');
    const warn = brm.level === 'danger' || brm.level === 'risky'
      ? `<p class="neg">⚠ 你的资金只有这个级别 ${brm.n.toFixed(1)} 个满买入（${brm.text}）。一次正常的下风期（输 10 个买入很常见）就可能让你破产。</p>` : '';
    const html = `<h3>${stake.name} $${stake.sb}/$${stake.bb}</h3>${warn}
      <div class="opts"><label>带入 <span><input type="range" id="sit-amt" min="${minB}" max="${maxB}" step="${stake.bb}" value="${maxB}" style="width:180px">
        <b id="sit-amt-v">$${fmt(maxB)}</b></span></label>
      <label>牌桌 <select id="sit-size"><option value="6">6 人桌</option><option value="9">9 人桌</option></select></label></div>
      <p class="note">当前资金 $${fmt(p.bankroll)}。离桌时桌上筹码全部退回资金。</p>`;
    const pr = showModal(html, [{ label: '取消', value: 'no' }, { label: '入座', value: 'yes', primary: true }]);
    $('sit-amt').oninput = (e) => { $('sit-amt-v').textContent = '$' + fmt(+e.target.value); };
    let amt = maxB, size = 6;
    $('sit-amt').addEventListener('change', (e) => { amt = +e.target.value; });
    $('sit-size').addEventListener('change', (e) => { size = +e.target.value; });
    $('sit-amt').addEventListener('input', (e) => { amt = +e.target.value; });
    const c = await pr;
    if (c !== 'yes') return;
    p.bankroll -= amt;
    p.activeSeat = { stack: amt, invested: amt, desc: `${stake.name} $${stake.sb}/$${stake.bb}` };
    Career.save();
    const lineup = PlayerDB.pick(stake.lv, size - 1);
    startGame({
      mode: 'cash', size, lineup, level: stake.lv, title: `${stake.name}`, pool: 'mixed', dynamicPool: true, observer: false,
      cash: { sb: stake.sb, bb: stake.bb, buyinBB: 100, rakePct: stake.rakePct, rakeCapBB: stake.rakeCapBB },
      hero: { name: p.name, stack: amt, stats: PlayerStats.from(p.heroStats), avatar: HERO_AVATAR },
    }, { kind: 'cash', stake });
  },

  async joinTour(t) {
    const p = Career.p, cost = t.buyin + t.fee;
    const brm = Career.brm(cost, 'tour');
    const c = await showModal(`<h3>${t.name}</h3><p>报名费 $${t.buyin} + 手续费 $${t.fee} = <b>$${fmt(cost)}</b>，${t.size} 人，起始筹码 ${t.startStack}，每 ${t.handsPerLevel} 手升盲。</p>` +
      `<p>资金：$${fmt(p.bankroll)}（${brm.n.toFixed(1)} 个报名费，<span class="brm ${brm.level}">${brm.text}</span>）</p><p class="note">中途离开视为弃赛，报名费不退。</p>`,
    [{ label: '取消', value: 'no' }, { label: '报名', value: 'yes', primary: true }]);
    if (c !== 'yes') return;
    p.bankroll -= cost;
    p.activeTour = { desc: t.name, cost };
    Career.save();
    const lineup = PlayerDB.pick(t.lv, t.size - 1);
    startGame({
      mode: 'tournament', size: t.size, lineup, level: t.lv, title: t.name, pool: 'mixed', observer: false,
      tour: { startStack: t.startStack, handsPerLevel: t.handsPerLevel, buyin: t.buyin },
      hero: { name: p.name, stack: t.startStack, stats: PlayerStats.from(p.heroStats), avatar: HERO_AVATAR },
    }, { kind: 'tour', tour: t });
  },

  /* ---------------- 玩家数据库 ---------------- */
  renderDB() {
    const el = $('lt-db');
    const f = this.dbFilter;
    const reveal = $('opt-reveal').checked;
    let list = PlayerDB.load().players.slice();
    if (f.persona) list = list.filter((p) => p.persona === f.persona);
    if (f.level) list = list.filter((p) => p.home === +f.level);
    const hands = (p) => (p.stats ? p.stats.hands : 0);
    if (f.sort === 'hands') list.sort((a, b) => hands(b) - hands(a));
    else list.sort((a, b) => a.home - b.home || a.persona.localeCompare(b.persona));
    let h = `<div class="filters">
      <label>身份 <select id="db-persona"><option value="">全部</option>${Object.entries(PERSONAS).map(([k, p]) => `<option value="${k}" ${f.persona === k ? 'selected' : ''}>${p.name}</option>`).join('')}</select></label>
      <label>常驻级别 <select id="db-level"><option value="">全部</option>${CASH_STAKES.map((s) => `<option value="${s.lv}" ${+f.level === s.lv ? 'selected' : ''}>${s.name} (L${s.lv})</option>`).join('')}</select></label>
      <label>排序 <select id="db-sort"><option value="level">按级别</option><option value="hands" ${f.sort === 'hands' ? 'selected' : ''}>按交手手数</option></select></label>
      <span class="note">共 ${list.length} 人。HUD 数据跨场次累计。外表符合刻板印象，但约 12% 的人“人不可貌相”。${reveal ? '' : '（在顶部勾选“显示对手真实风格”可查看真实风格与技术）'}</span>
      </div><div class="db-grid">`;
    for (const p of list) {
      const P = PERSONAS[p.persona];
      const s = PlayerStats.from(p.stats);
      const mp = s.mapPoint(6);
      const hud = s.hands ? `VPIP ${fmtPct(s.vpipPct)} · PFR ${fmtPct(s.pfrPct)} · AF ${s.af == null ? '-' : s.af.toFixed(1)} · ${s.hands} 手` : '<span class="muted">尚无数据</span>';
      const truth = reveal ? `<div style="color:${styleColor(p.x, p.y)}">真实：${classifyStyle(p.x, p.y)} · 技术 ${Math.round(p.skill * 100)}${p.atypical ? ' · <b>反刻板印象</b>' : ''}</div>` : '';
      h += `<div class="db-card">${avatarSVG(p.avatar, 64)}<div class="info"><b>${esc(p.name)}</b> <span class="muted">${P.name} · ${p.female ? '女' : '男'} · ${p.age}岁 · L${p.home}</span>
        <div class="muted">${P.desc}</div><div>${hud}</div>${mp && s.hands >= 25 ? `<div>HUD 判定：${classifyStyle(mp.x, mp.y)}</div>` : ''}${truth}</div></div>`;
    }
    h += '</div><div class="row" style="margin-top:12px"><button id="db-regen" style="opacity:.6">重新生成玩家数据库（清空所有 HUD 记录）</button></div>';
    el.innerHTML = h;
    $('db-persona').onchange = (e) => { f.persona = e.target.value; this.renderDB(); };
    $('db-level').onchange = (e) => { f.level = e.target.value; this.renderDB(); };
    $('db-sort').onchange = (e) => { f.sort = e.target.value; this.renderDB(); };
    $('db-regen').onclick = async () => {
      const c = await showModal('<h3>重新生成玩家数据库？</h3><p>所有虚拟玩家和他们的 HUD 记录都会被替换。</p>', [{ label: '取消', value: 'no', primary: true }, { label: '重新生成', value: 'yes' }]);
      if (c === 'yes') { PlayerDB.reset(); this.renderDB(); }
    };
  },

  /* ---------------- 复盘列表 ---------------- */
  renderReviewList() {
    const el = $('lt-review');
    const list = HandStore.list();
    let h = `<div class="panel"><h2>已标记的手牌</h2>
      <p class="note">在牌桌上点击「☆ 标记本手」（或按 M 键）即可保存手牌。复盘时，你先在每个决策点给出自己的判断，再对照近似 GTO 的建议与 EV 估算。</p>`;
    if (!list.length) h += '<p class="note">还没有标记过手牌。</p>';
    else {
      h += '<table class="data-table"><tr><th>时间</th><th>牌局</th><th>手牌</th><th>公共牌</th><th>结果</th><th>决策点</th><th>复盘评分</th><th></th></tr>';
      for (const r of list) {
        const rv = r.review;
        h += `<tr><td>${new Date(r.ts).toLocaleString()}</td><td style="text-align:left">${esc(r.title)} #${r.no}</td>
          <td>${cardsInline(r.heroHole)}</td><td>${r.board.length ? cardsInline(r.board) : '-'}</td>
          <td class="${r.heroNet >= 0 ? 'pos' : 'neg'}">${r.heroNet >= 0 ? '+' : ''}${fmt(r.heroNet)}（${(r.heroNet / r.bb).toFixed(1)}BB）</td>
          <td>${r.decisions.length}</td><td>${rv ? `<span class="gradebox g-${rv.gradeClass}">${rv.summary}</span>` : '<span class="note">未复盘</span>'}</td>
          <td><button data-rv="${r.id}" class="primary">复盘</button> <button data-del="${r.id}">删除</button></td></tr>`;
      }
      h += '</table>';
    }
    el.innerHTML = h + '</div>';
    el.querySelectorAll('[data-rv]').forEach((b) => b.onclick = () => Review.open(b.dataset.rv));
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { HandStore.remove(b.dataset.del); this.renderReviewList(); });
  },
};
