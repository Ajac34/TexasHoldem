'use strict';
/* 复盘模式：逐个决策点——先让玩家自己判断，再展示近似 GTO 的频率、EV、MDF 与上帝视角 */

const Review = {
  rec: null, idx: 0, phase: 'ask', mine: [], notes: [], cache: [],

  open(id) {
    const rec = HandStore.get(id);
    if (!rec) return;
    this.rec = rec; this.idx = 0; this.phase = 'ask';
    this.mine = []; this.notes = []; this.cache = [];
    $('lobby').classList.add('hidden');
    $('game').classList.add('hidden');
    $('review').classList.remove('hidden');
    $('rv-god').checked = false;
    $('rv-god').onchange = () => this.render();
    $('rv-back').onclick = () => { $('review').classList.add('hidden'); $('lobby').classList.remove('hidden'); Lobby.refresh(); };
    $('review-title').innerHTML = `<b>${esc(rec.title)}</b> 第 ${rec.no} 手 · 盲注 ${rec.sb}/${rec.bb}${rec.ante ? ' 前注 ' + rec.ante : ''} · ${new Date(rec.ts).toLocaleString()}`;
    this.render();
  },

  analysis(i) {
    if (!this.cache[i]) this.cache[i] = GTO.analyze(this.rec.decisions[i]);
    return this.cache[i];
  },

  done() { return this.idx >= this.rec.decisions.length; },

  render() {
    const rec = this.rec;
    if (!rec.decisions.length) {
      $('review-left').innerHTML = this.logHTML(rec.log.length);
      $('review-right').innerHTML = '<h3>这手牌你没有需要做的决定</h3><p class="note">（例如所有人弃牌给你的大盲。）</p>';
      return;
    }
    if (this.done()) { this.renderSummary(); return; }
    const d = rec.decisions[this.idx];
    const god = $('rv-god').checked;
    const street = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' }[d.street];
    let L = `<h3>决策 ${this.idx + 1} / ${rec.decisions.length}：${street}</h3>`;
    L += `<div class="rv-felt"><div class="rv-row"><span style="width:60px">公共牌</span>${d.board.length ? d.board.map((c) => cardHTML(c, 'sm')).join('') : '<span class="note">（翻前）</span>'}</div>`;
    L += `<div class="rv-row"><span style="width:60px">你的牌</span>${d.hole.map((c) => cardHTML(c, 'lg')).join('')}
      <div style="margin-left:12px;line-height:1.7">位置 <b>${d.posLabel}</b>${d.ip ? '（有位置）' : d.street !== 'preflop' ? '（无位置）' : ''}<br>
      底池 <b>${fmt(d.pot)}</b>（${(d.pot / d.bb).toFixed(1)}BB）<br>
      ${d.toCall > 0 ? `需跟注 <b>${fmt(d.toCall)}</b>（底池赔率 ${Math.round(d.toCall / (d.pot + d.toCall) * 100)}%）` : '无人下注'}<br>
      你的筹码 ${fmt(d.stack)}（有效 ${d.effBB.toFixed(0)}BB）</div></div>`;
    L += '<div class="rv-row" style="flex-direction:column;align-items:stretch">';
    for (const o of d.opps) {
      const pl = rec.players.find((p) => p.id === o.id) || {};
      const av = pl.avatar ? avatarSVG(pl.avatar, 40) : '';
      const showCards = god || (this.phase === 'reveal' && god);
      L += `<div class="rv-opp">${av}<div style="flex:1"><b>${esc(o.name)}</b> ${pl.persona ? `<span class="note">${PERSONAS[pl.persona].name}</span>` : ''}<br>
        <span class="note">筹码 ${fmt(o.stack)} · 本街已下 ${fmt(o.bet)} · 推测范围：前 ${Math.round(o.range.range * 100)}% 的起手牌${o.range.aggr ? `，翻后主动下注/加注 ${o.range.aggr} 次` : ''}${o.range.calls ? `，跟注 ${o.range.calls} 次` : ''}</span></div>
        ${showCards ? cardsInline(o.hole, 'sm') : '<span class="note">?? </span>'}</div>`;
    }
    L += '</div></div>';
    L += '<h3 style="margin-top:14px">行动记录</h3>' + this.logHTML(d.logIndex);
    $('review-left').innerHTML = L;

    if (this.phase === 'ask') this.renderAsk(d); else this.renderReveal(d);
  },

  logHTML(upto) {
    const rec = this.rec;
    const lines = rec.log.map(([m, c], i) => `<div class="${c} ${i >= upto ? 'future' : ''}">${esc(m)}</div>`);
    const visible = this.done() ? lines : lines.slice(0, upto);
    return `<div class="rv-log">${visible.join('') || '<span class="note">（这是本手第一个动作）</span>'}</div>`;
  },

  renderAsk(d) {
    const keys = GTO.legalKeys(d);
    const R = $('review-right');
    R.innerHTML = `<h3>你的分析</h3><p>冷静下来再看一次：在这个局面下，你认为<b>最好的打法</b>是什么？（先不要看你当时的选择）</p>
      <div class="rv-choices">${keys.map((k) => `<button data-k="${k}" class="${this.mine[this.idx] === k ? 'sel' : ''}">${this.keyLabel(d, k)}</button>`).join('')}</div>
      <p class="note">理由（可选，写下你考虑了对手的什么范围、底池赔率等）：</p>
      <textarea id="rv-note">${esc(this.notes[this.idx] || '')}</textarea>
      <div class="lobby-actions"><button id="rv-submit" class="primary" ${this.mine[this.idx] ? '' : 'disabled'}>提交并查看分析</button>
      ${this.idx > 0 ? '<button id="rv-prev">上一步</button>' : ''}</div>`;
    R.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { this.mine[this.idx] = b.dataset.k; this.notes[this.idx] = $('rv-note').value; this.render(); });
    $('rv-submit').onclick = () => { this.notes[this.idx] = $('rv-note').value; this.phase = 'reveal'; this.render(); };
    if ($('rv-prev')) $('rv-prev').onclick = () => { this.idx--; this.phase = 'reveal'; this.render(); };
  },

  keyLabel(d, k) {
    if (k === 'call') return `跟注 ${fmt(d.toCall)}`;
    if (k === 'raise') return d.street === 'preflop' ? (d.preflopRaises === 0 ? '加注（开池/隔离）' : `再加注（${d.preflopRaises + 2}Bet）`) : '加注（约 3/4 池）';
    if (k === 'allin') return `全下 ${fmt(d.maxTo)}`;
    return GTO.LABELS[k];
  },

  renderReveal(d) {
    const R = $('review-right');
    R.innerHTML = '<p class="note">计算中…</p>';
    setTimeout(() => {
      const r = this.analysis(this.idx);
      const actual = r.actualKey, mine = this.mine[this.idx];
      const gA = GTO.grade(r, actual), gM = GTO.grade(r, mine);
      const keys = r.keys.slice().sort((a, b) => (r.freq[b] || 0) - (r.freq[a] || 0));
      let h = '<h3>近似 GTO 分析</h3>';
      h += '<div class="freq-row" style="color:var(--muted)"><span>选项</span><span>建议频率</span><span>频率</span><span>EV（BB）</span></div>';
      for (const k of keys) {
        const f = r.freq[k] || 0;
        const ev = r.ev ? (r.ev[k] == null || !isFinite(r.ev[k]) ? '-' : (r.ev[k] >= 0 ? '+' : '') + r.ev[k].toFixed(2)) : '-';
        const tags = (k === actual ? ' <b style="color:#f5c542">← 实战</b>' : '') + (k === mine ? ' <b style="color:#8fc1ff">← 你的复盘</b>' : '');
        h += `<div class="freq-row ${k === actual ? 'actual' : ''}"><span>${this.keyLabel(d, k)}</span><div class="freq-bar"><div style="width:${Math.round(f * 100)}%"></div></div><span>${Math.round(f * 100)}%</span><span>${ev}${tags}</span></div>`;
      }
      const lossTxt = (g) => (g && g.loss != null && g.loss > 0.05 ? `（约损失 ${g.loss.toFixed(2)}BB）` : '');
      h += `<p style="margin-top:12px">实战选择：<b>${actual ? this.keyLabel(d, actual) : '-'}</b> <span class="gradebox g-${gA.g}">${gA.text}</span> ${lossTxt(gA)}</p>`;
      h += `<p>你的复盘判断：<b>${this.keyLabel(d, mine)}</b> <span class="gradebox g-${gM.g}">${gM.text}</span> ${lossTxt(gM)}</p>`;
      if (this.notes[this.idx]) h += `<p class="note">你的理由：${esc(this.notes[this.idx])}</p>`;
      h += '<h4>要点</h4><ul class="rv-notes">' + r.notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>';
      if (r.eqActual != null) {
        h += `<p>上帝视角：对手实际手牌 ${d.opps.map((o) => `${esc(o.name)} ${cardsInline(o.hole)}`).join('，')}，你此时的真实胜率 <b>${Math.round(r.eqActual * 100)}%</b>。` +
          '<span class="note">（GTO 评价的是“面对对手整个范围”的决定，结果好坏与决定好坏不是一回事。）</span></p>';
      }
      h += '<p class="note">说明：这是基于标准范围表与“对手按最小防守频率应对”模型的近似分析，不是真正的 GTO 求解器结果；EV 只计算到当前街（翻后用胜率实现系数粗略修正）。</p>';
      h += `<div class="lobby-actions"><button id="rv-next" class="primary">${this.idx + 1 < this.rec.decisions.length ? '下一个决策点' : '查看总结'}</button>
        <button id="rv-again">修改我的判断</button></div>`;
      R.innerHTML = h;
      $('rv-next').onclick = () => { this.idx++; this.phase = 'ask'; this.render(); };
      $('rv-again').onclick = () => { this.phase = 'ask'; this.render(); };
    }, 20);
  },

  renderSummary() {
    const rec = this.rec;
    $('review-left').innerHTML = `<h3>完整牌局</h3><div class="rv-row">${rec.players.map((p) => `<div class="rv-opp">${p.avatar ? avatarSVG(p.avatar, 36) : (p.isHero ? heroAvatar(36) : '')}<div><b>${esc(p.name)}</b>${p.isHero ? '（你）' : ''}<br>${cardsInline(p.hole)} <span class="${p.endStack - p.startStack >= 0 ? 'pos' : 'neg'}">${p.endStack - p.startStack >= 0 ? '+' : ''}${fmt(p.endStack - p.startStack)}</span></div></div>`).join('')}</div>
      <div class="rv-row">公共牌 ${rec.board.length ? rec.board.map((c) => cardHTML(c, 'sm')).join('') : '（无）'}</div>` + this.logHTML(rec.log.length);
    const items = rec.decisions.map((d, i) => {
      const r = this.analysis(i);
      return { street: d.street, actual: r.actualKey, gA: GTO.grade(r, r.actualKey), mine: this.mine[i], gM: GTO.grade(r, this.mine[i]), best: r.bestKey, d };
    });
    const worst = items.reduce((w, it) => Math.max(w, ['good', 'ok', 'bad', 'terrible'].indexOf(it.gA.g)), 0);
    const gradeClass = ['good', 'ok', 'bad', 'terrible'][worst];
    const summary = ['打得很好', '基本正确', '有失误', '有严重失误'][worst];
    const agree = items.filter((it) => it.gM && (it.gM.g === 'good' || it.gM.g === 'ok')).length;
    let h = `<h3>复盘总结 <span class="gradebox g-${gradeClass}">${summary}</span></h3>
      <p>本手结果：<b class="${rec.heroNet >= 0 ? 'pos' : 'neg'}">${rec.heroNet >= 0 ? '+' : ''}${fmt(rec.heroNet)}（${(rec.heroNet / rec.bb).toFixed(1)}BB）</b>。你的复盘判断有 ${agree}/${items.length} 个与建议一致或可接受。</p>
      <table class="data-table"><tr><th>街</th><th>实战</th><th>评分</th><th>你的复盘</th><th>评分</th><th>建议首选</th></tr>`;
    for (const it of items) {
      h += `<tr><td>${{ preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' }[it.street]}</td>
        <td>${this.keyLabel(it.d, it.actual)}</td><td><span class="gradebox g-${it.gA.g}">${it.gA.text}</span></td>
        <td>${it.mine ? this.keyLabel(it.d, it.mine) : '-'}</td><td>${it.gM ? `<span class="gradebox g-${it.gM.g}">${it.gM.text}</span>` : '-'}</td>
        <td>${this.keyLabel(it.d, it.best)}</td></tr>`;
    }
    h += '</table><p class="note">记住：结果（输赢）≠ 决策质量。长期盈利来自每个决策点的正期望。</p>';
    h += '<div class="lobby-actions"><button id="rv-restart">重新复盘</button><button id="rv-done" class="primary">返回列表</button></div>';
    $('review-right').innerHTML = h;
    rec.review = { ts: Date.now(), summary, gradeClass, items: items.map((it) => ({ street: it.street, actual: it.actual, actualGrade: it.gA.g, mine: it.mine, mineGrade: it.gM && it.gM.g })) };
    HandStore.update(rec);
    $('rv-restart').onclick = () => { this.idx = 0; this.phase = 'ask'; this.mine = []; this.render(); };
    $('rv-done').onclick = () => { $('review').classList.add('hidden'); $('lobby').classList.remove('hidden'); Lobby.show('review'); };
  },
};
