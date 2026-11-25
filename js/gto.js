'use strict';
/* 复盘分析：近似 GTO 基准（启发式，不是真正的求解器）
 *  - 翻前：标准开池/防守/3Bet/4Bet 范围表（按位置），短码使用推/弃近似
 *  - 翻后：对“对手按其行动推测的范围”计算胜率，用最小防守频率(MDF)模型估算各选项 EV
 */
const GTO = (() => {
  const OPEN6 = { UTG: 0.15, HJ: 0.19, CO: 0.27, BTN: 0.45, SB: 0.40 };
  const OPEN9 = { UTG: 0.10, UTG1: 0.11, UTG2: 0.13, LJ: 0.15, HJ: 0.19, CO: 0.27, BTN: 0.45, SB: 0.40 };
  const LABELS = { fold: '弃牌', check: '过牌', call: '跟注', bet_s: '小注 1/3 池', bet_m: '中注 2/3 池', bet_l: '大注 满池', raise: '加注', allin: '全下' };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const inRange = (pct, b, w = 0.025) => 1 / (1 + Math.exp((pct - b) / (w / 2.5)));
  const pc = (v) => Math.round(v * 100) + '%';

  function openRange(label, n) {
    const t = n >= 7 ? OPEN9 : OPEN6;
    if (t[label] != null) return t[label];
    if (n <= 3 && label === 'BTN') return 0.5;
    return 0.2;
  }

  /* 把实际动作映射为选项 key */
  function actionKey(d, a) {
    if (!a) return null;
    if (a.type === 'fold' || a.type === 'check' || a.type === 'call') return a.type;
    if (a.allIn || a.to >= d.maxTo) return 'allin';
    if (d.street === 'preflop' || d.toCall > 0) return 'raise';
    const frac = a.to / Math.max(1, d.pot);
    return frac <= 0.45 ? 'bet_s' : frac <= 0.85 ? 'bet_m' : 'bet_l';
  }

  function legalKeys(d) {
    const k = [];
    if (d.toCall > 0) k.push('fold', 'call'); else k.push('check');
    if (d.canRaise && d.stack > d.toCall) {
      if (d.street !== 'preflop' && d.toCall === 0) {
        for (const [key, f] of [['bet_s', 0.33], ['bet_m', 0.66], ['bet_l', 1]]) if (f * d.pot < d.stack * 0.9) k.push(key);
      } else if (d.minRaiseTo < d.maxTo * 0.9) k.push('raise');
      k.push('allin');
    }
    return k;
  }

  function normalize(freq, keys) {
    let tot = 0;
    for (const k of keys) { freq[k] = Math.max(0, freq[k] || 0); tot += freq[k]; }
    if (tot <= 0) { freq[keys[0]] = 1; tot = 1; }
    for (const k of keys) freq[k] /= tot;
    return freq;
  }

  /* ---------------- 翻前 ---------------- */
  function preflop(d) {
    const keys = legalKeys(d);
    const f = {};
    const notes = [];
    const pct = d.pct, n = d.nPlayers, top = Math.max(1, Math.round(d.handTop * 100));
    let boundary = null;
    const passive = d.toCall > 0 ? 'fold' : 'check';
    const aggro = keys.includes('raise') ? 'raise' : 'allin';
    notes.push(`你的手牌 ${d.handKey} 约排在所有起手牌的前 ${top}%。位置：${d.posLabel}，有效筹码 ${d.effBB.toFixed(0)}BB。`);

    if (d.preflopRaises === 0 && d.effBB <= 15) {
      const late = d.posLabel === 'SB' ? 1.15 : 0.3 + 0.7 * d.lateness;
      boundary = Math.min(1, (4.2 / Math.max(1, d.effBB)) * late);
      f.allin = inRange(pct, boundary); f[passive] = 1 - f.allin;
      notes.push(`短码（≤15BB）未开池时应采用推/弃策略：此位置约用前 ${pc(boundary)} 的牌全下，平跟或小加注会让你在被反推时陷入两难。`);
    } else if (d.preflopRaises === 0) {
      if (d.toCall === 0) {
        boundary = d.limpers ? 0.12 : 0.15;
        f.raise = inRange(pct, boundary); f.check = 1 - f.raise;
        notes.push(`大盲位有人溜入：前 ${pc(boundary)} 左右的牌加注隔离，其余过牌看翻牌（免费）。`);
      } else if (d.limpers > 0) {
        const o = openRange(d.posLabel, n);
        boundary = o * 0.65;
        f.raise = inRange(pct, boundary);
        const late = ['BTN', 'CO', 'SB'].includes(d.posLabel);
        f.call = late ? Math.max(0, inRange(pct, o * 0.95) - f.raise) : 0;
        f.fold = 1 - f.raise - f.call;
        notes.push(`前面有 ${d.limpers} 人溜入：用约前 ${pc(boundary)} 的牌加注隔离（加注到 ${3 + d.limpers}BB 左右）${late ? '，后位可以用投机牌（同花连张、小对子）跟着溜入' : ''}，其余弃牌。`);
      } else {
        boundary = openRange(d.posLabel, n);
        f.raise = inRange(pct, boundary);
        if (d.posLabel === 'SB') { f.call = Math.max(0, (inRange(pct, 0.6) - f.raise) * 0.4); }
        f.fold = 1 - f.raise - (f.call || 0);
        notes.push(`无人入池时 ${d.posLabel} 的标准开池范围约前 ${pc(boundary)}，基本是“加注或弃牌”，不建议溜入。`);
      }
    } else {
      const bigCommit = d.toCall >= 0.35 * (d.stack + d.betThisStreet) || d.effBB <= 15;
      if (bigCommit) {
        const opps = d.opps.filter((o) => o.range.range < 1 || o.bet > 0).map((o) => o.range);
        const eq = Equity.equity(d.hole, [], opps.length ? opps : [{ range: 0.3 }], 2500);
        const need = d.toCall / (d.pot + d.toCall);
        const go = 1 / (1 + Math.exp(-(eq - need) / 0.02));
        const k = keys.includes('allin') && d.effBB <= 25 ? 'allin' : 'call';
        f[k] = go; f.fold = 1 - go;
        notes.push(`这是一个大额（接近全下）的决定：你对对手推测范围的胜率约 ${pc(eq)}，需要的底池赔率 ${pc(need)}。胜率高于赔率就该继续。`);
        if (d.mode === 'tournament') notes.push('锦标赛中还要考虑 ICM：临近奖励圈时，输掉筹码的代价大于赢得筹码的收益，所以实际需要的胜率比底池赔率更高。');
      } else if (d.preflopRaises === 1) {
        const rl = d.raiserLateness;
        let tb, def;
        if (d.posLabel === 'BB') { tb = 0.06 + 0.06 * rl; def = 0.22 + 0.35 * rl; }
        else if (d.posLabel === 'SB') { tb = 0.07 + 0.06 * rl; def = tb + 0.02; }
        else if (d.ip) { tb = 0.04 + 0.04 * rl; def = tb + 0.05 + 0.05 * rl; }
        else { tb = 0.04 + 0.04 * rl; def = tb + 0.01; }
        if (d.raiseBB > 3.5) def = tb + (def - tb) * clamp(3 / d.raiseBB, 0.4, 1);
        boundary = def;
        f.raise = inRange(pct, tb); f.call = Math.max(0, inRange(pct, def) - f.raise); f.fold = 1 - f.raise - f.call;
        notes.push(`面对 ${d.raiserLabel || '前位'} 的加注（${d.raiseBB.toFixed(1)}BB）：约前 ${pc(tb)} 3Bet，继续（3Bet+跟注）的总范围约前 ${pc(def)}。` +
          (d.posLabel === 'BB' ? '大盲已投入 1BB，赔率好，防守范围最宽。' : d.ip ? '有位置可以多跟注。' : '没有位置时以“3Bet 或弃牌”为主。'));
      } else if (d.preflopRaises === 2) {
        const fb = 0.025, cr = d.ip ? 0.07 : 0.045;
        boundary = cr;
        f.raise = inRange(pct, fb, 0.01); f.call = Math.max(0, inRange(pct, cr, 0.015) - f.raise); f.fold = 1 - f.raise - f.call;
        notes.push(`面对 3Bet：约前 ${pc(fb)} 4Bet（价值），继续范围约前 ${pc(cr)}，其余弃牌。`);
      } else {
        boundary = 0.035;
        f.allin = inRange(pct, 0.02, 0.008); f.call = Math.max(0, inRange(pct, 0.035, 0.01) - f.allin); f.fold = 1 - f.allin - f.call;
        notes.push('面对 4Bet 及以上：只用最强的约 2%（QQ+、AK）全下，极少数牌跟注。');
      }
    }
    if (!keys.includes('raise') && f.raise) { f.allin = (f.allin || 0) + f.raise; f.raise = 0; }
    if (!keys.includes('allin') && f.allin) { f[keys.includes('raise') ? 'raise' : 'call'] = (f.call || 0) + f.allin; f.allin = 0; }
    if (!keys.includes('fold') && f.fold) { f.check = (f.check || 0) + f.fold; f.fold = 0; }
    void aggro;
    normalize(f, keys);
    return { keys, freq: f, ev: null, notes, boundary };
  }

  /* ---------------- 翻后 ---------------- */
  function postflop(d) {
    const keys = legalKeys(d);
    const bb = d.bb;
    const opps = d.opps.map((o) => o.range);
    const eq = Equity.equity(d.hole, d.board, opps, 2500);
    const eqCalled = Equity.equity(d.hole, d.board, opps.map((o) => ({ ...o, calls: (o.calls || 0) + 1 })), 2000);
    const eqStrong = Equity.equity(d.hole, d.board, opps.map((o) => ({ ...o, aggr: (o.aggr || 0) + 1 })), 2000);
    const realize = d.street === 'river' ? 1 : d.ip ? 0.95 : 0.85;
    const pot = d.pot, toCall = d.toCall;
    const ev = {};
    const notes = [];
    const potBB = pot / bb;
    const made = describeHand(evaluate(d.hole.concat(d.board)));
    notes.push(`牌力：${made}。对手按其行动推测的范围下，你的胜率约 ${pc(eq)}（被跟注时约 ${pc(eqCalled)}）。`);

    if (toCall === 0) {
      ev.check = eq * pot * realize;
      for (const [k, fr] of [['bet_s', 0.33], ['bet_m', 0.66], ['bet_l', 1], ['allin', null]]) {
        if (!keys.includes(k)) continue;
        const B = fr == null ? d.stack : Math.min(fr * pot, d.stack);
        const fold = B / (pot + B);
        ev[k] = fold * pot + (1 - fold) * (eqCalled * realize * (pot + 2 * B) - B);
      }
      const bestBet = ['bet_s', 'bet_m', 'bet_l'].filter((k) => ev[k] != null).sort((a, b) => ev[b] - ev[a])[0];
      if (bestBet) {
        const B = { bet_s: 0.33, bet_m: 0.66, bet_l: 1 }[bestBet] * pot;
        notes.push(`下注 ${LABELS[bestBet]}：均衡下对手需要防守 ${pc(pot / (pot + B))}，即约 ${pc(B / (pot + B))} 的时候直接弃牌；被跟注时你对其跟注范围的胜率约 ${pc(eqCalled)}。`);
      }
      notes.push(eq > 0.65 ? '你的牌强于对手范围，下注可以从更差的牌那里拿到价值。'
        : eq < 0.3 ? '你的牌很弱：要么放弃，要么作为诈唬下注（选择有听牌/阻断牌的手牌诈唬，而不是毫无希望的牌）。'
          : '中等牌力：下注常常只会被更好的牌跟注、更差的牌弃掉，过牌保留摊牌价值往往更好。');
    } else {
      const P = pot - toCall;
      const mdf = P / pot;
      const need = toCall / (pot + toCall);
      ev.fold = 0;
      ev.call = eq * realize * (pot + toCall) - toCall;
      for (const k of ['raise', 'allin']) {
        if (!keys.includes(k)) continue;
        const R = k === 'allin' ? d.maxTo : Math.min(d.maxTo, Math.max(d.minRaiseTo, d.currentBet + (pot + toCall) * 0.75));
        const extra = R - d.betThisStreet;
        const inc = R - d.currentBet;
        const fold = inc / (pot + toCall + inc);
        ev[k] = fold * pot + (1 - fold) * (eqStrong * realize * (pot + extra + inc) - extra);
      }
      notes.push(`需要跟注 ${toCall}，底池赔率要求胜率 ≥ ${pc(need)}${d.street !== 'river' ? '（还有后续街，需要考虑能否实现胜率）' : ''}。`);
      notes.push(`最小防守频率 MDF = ${pc(mdf)}：面对这个尺度，整体范围至少要继续 ${pc(mdf)}，否则对手用任意两张牌诈唬都能盈利。但具体某手牌是否防守，取决于它在你范围里的强弱。`);
    }
    const evBB = {};
    for (const k of keys) evBB[k] = (ev[k] ?? -Infinity) / bb;
    const best = Math.max(...keys.map((k) => evBB[k]));
    const T = Math.max(0.3, 0.04 * potBB);
    const freq = {};
    for (const k of keys) freq[k] = Math.exp((evBB[k] - best) / T);
    normalize(freq, keys);
    for (const k of keys) if (freq[k] < 0.05) freq[k] = 0;
    normalize(freq, keys);
    return { keys, freq, ev: evBB, notes, eq, eqCalled, potBB };
  }

  function analyze(d) {
    const r = d.street === 'preflop' ? preflop(d) : postflop(d);
    r.street = d.street;
    r.actualKey = actionKey(d, d.action);
    if (r.actualKey && !r.keys.includes(r.actualKey)) r.keys.push(r.actualKey);
    // 上帝视角：对手真实手牌下的胜率
    const hands = d.opps.map((o) => o.hole).filter((h) => h && h.length === 2);
    if (hands.length) r.eqActual = Equity.vsHands(d.hole, d.board, hands, 3000);
    r.bestKey = r.keys.slice().sort((a, b) => (r.freq[b] || 0) - (r.freq[a] || 0))[0];
    return r;
  }

  /* 评分：正确 / 可接受 / 失误 / 严重失误 */
  function grade(r, key) {
    if (!key) return null;
    const fq = r.freq[key] || 0;
    if (r.ev) {
      const best = Math.max(...r.keys.map((k) => r.ev[k] ?? -Infinity));
      const loss = best - (r.ev[key] ?? best);
      const pb = r.potBB;
      if (loss <= Math.max(0.3, 0.03 * pb) || fq >= 0.4) return { g: 'good', text: '正确', loss };
      if (loss <= 0.12 * pb || fq >= 0.15) return { g: 'ok', text: '可接受', loss };
      if (loss <= 0.35 * pb) return { g: 'bad', text: '失误', loss };
      return { g: 'terrible', text: '严重失误', loss };
    }
    if (fq >= 0.5) return { g: 'good', text: '正确' };
    if (fq >= 0.15) return { g: 'ok', text: '可接受（混合策略）' };
    const bestFq = Math.max(...r.keys.map((k) => r.freq[k] || 0));
    if (bestFq > 0.9 && fq < 0.03) return { g: 'terrible', text: '严重失误' };
    return { g: 'bad', text: '失误' };
  }

  return { analyze, grade, LABELS, actionKey, legalKeys };
})();
