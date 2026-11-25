'use strict';
/* AI 决策
 * 两个模型共用同一个风格参数（由 x=松紧 / y=凶弱 推出），区别在于：
 *  - 现金桌模型：深筹码，按筹码 EV（底池赔率 + 风格偏差）决策，有隐含赔率、慢打、诈唬
 *  - 锦标赛模型：在现金桌模型之上加入有效筹码深度（推/弃模式）、ICM 泡沫因子、筹码领先者施压
 * AI 只能看到对手的 HUD 统计（而不是对手真实风格），用它来估计对手范围。
 */
const AI = (() => {
  const FOLD = { type: 'fold' }, CHECK = { type: 'check' }, CALL = { type: 'call' };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function checkOrFold(ctx) { return ctx.toCall > 0 ? FOLD : CHECK; }

  function raiseTo(t, ctx, amt) {
    if (!ctx.canRaise) return ctx.toCall > 0 ? CALL : CHECK;
    amt = t.roundChips(amt);
    amt = Math.max(amt, ctx.minRaiseTo);
    if (amt >= ctx.maxTo) amt = ctx.maxTo;
    // 剩余筹码太少时直接全下
    if (ctx.maxTo - amt < 0.3 * amt) amt = ctx.maxTo;
    return { type: 'raise', amount: amt };
  }

  function effectiveStack(t, p) {
    const mine = p.stack + p.bet;
    let other = 0;
    for (const q of t.inHandPlayers()) if (q !== p) other = Math.max(other, q.stack + q.bet);
    return Math.min(mine, other);
  }

  /* 通过 HUD 数据估计对手当前范围 */
  function oppRange(t, opp, viewer) {
    // 技术越高，读人越快（需要的样本越少），对 AI 对手的判断也越接近其真实倾向
    const sk = viewer && viewer.params ? viewer.params.skill : 0.4;
    const s = opp.stats, n = s.hands, W = Math.round(22 - 16 * sk);
    let vpip = (s.vpip + 0.28 * W) / (n + W);
    let pfr = (s.pfr + 0.14 * W) / (n + W);
    if (sk > 0.5 && opp.params) {
      const w = Math.min(0.6, (sk - 0.5) * 1.2);
      vpip += (opp.params.vpip - vpip) * w; pfr += (opp.params.pfr - pfr) * w;
    }
    const acts = t.hand.actions.filter((a) => a.pid === opp.id);
    const pre = acts.filter((a) => a.street === 'preflop');
    const raises = pre.filter((a) => a.type === 'raise');
    let range = 1;
    if (raises.length) {
      const lr = raises[raises.length - 1];
      range = lr.facing === 0 ? pfr : lr.facing === 1 ? Math.max(0.03, pfr * 0.35) : Math.max(0.02, pfr * 0.15);
      if (lr.allIn) {
        const bbs = opp.startStack / t.bb;
        if (bbs < 20) range = Math.max(range, Math.min(0.65, 3.8 / bbs));
      }
    } else {
      const c = pre.find((a) => a.type === 'call');
      if (c) range = c.facing === 0 ? vpip : c.facing === 1 ? vpip * 0.6 : vpip * 0.3;
    }
    let aggr = 0, calls = 0;
    for (const a of acts) {
      if (a.street === 'preflop') continue;
      if (a.type === 'bet' || a.type === 'raise') aggr++;
      else if (a.type === 'call') calls++;
    }
    const agf = s.postBR + s.postCall + s.postFold;
    const bluffy = (s.postBR + 0.3 * 10) / (agf + 10);
    return { range: clamp(range, 0.02, 1), aggr, calls, bluffy };
  }

  function eqIters(t, n, P) { return Math.round((n >= 3 ? 280 : 380) * (t.eqScale || 1) * (P ? 0.7 + 0.8 * P.skill : 1)); }

  /* ---------------- 锦标赛：ICM ---------------- */
  function aliveTourPlayers(t) { return t.players.filter((q) => q.startStack > 0 || q.stack > 0); }

  function bubbleFactor(t, p, mainOpp) {
    const tr = t.tournament;
    if (!tr || !mainOpp) return 1;
    const alive = aliveTourPlayers(t);
    if (alive.length <= 1) return 1;
    const stacks = alive.map((q) => q.startStack);
    const me = alive.indexOf(p), op = alive.indexOf(mainOpp);
    if (me < 0 || op < 0) return 1;
    const X = Math.min(stacks[me], stacks[op]);
    const pay = tr.payouts;
    const e0 = icmEquity(stacks, pay)[me];
    const sw = stacks.slice(); sw[me] += X; sw[op] -= X;
    const sl = stacks.slice(); sl[me] -= X; sl[op] += X;
    const ew = icmEquity(sw, pay)[me];
    const el = icmEquity(sl, pay)[me];
    const gain = ew - e0, loss = e0 - el;
    if (gain <= 1e-9) return 3;
    return clamp(loss / gain, 1, 3.5);
  }

  function bubblePressure(t) {
    const tr = t.tournament; if (!tr) return 0;
    const left = aliveTourPlayers(t).length;
    const paid = tr.payouts.length;
    const d = left - paid;
    if (d <= 0) return 0.35; // 已进钱圈，奖金阶梯仍有压力
    if (d === 1) return 1;
    if (d === 2) return 0.6;
    if (d === 3) return 0.3;
    return 0.1;
  }

  function mainAggressor(t, p) {
    const h = t.hand;
    for (let i = h.actions.length - 1; i >= 0; i--) {
      const a = h.actions[i];
      if ((a.type === 'raise' || a.type === 'bet') && a.pid !== p.id) return t.players.find((q) => q.id === a.pid);
    }
    return t.players.find((q) => q.id === h.preflopAggressor) || null;
  }

  /* ---------------- 大额跟注/全下决策 ---------------- */
  function callOff(t, p, ctx, P, preferShove) {
    const opps = t.inHandPlayers()
      .filter((q) => q !== p && (t.hand.actions.some((a) => a.pid === q.id && a.street === t.street && a.type !== 'check') || t.street !== 'preflop'))
      .map((q) => oppRange(t, q, p));
    if (!opps.length) opps.push({ range: 0.3, aggr: 0, calls: 0 });
    const eq = Equity.equity(p.hole, t.board, opps, eqIters(t, opps.length, P) + 100, t.rng);
    const pot = ctx.pot, call = ctx.toCall;
    let need = call / (pot + call);
    if (t.mode === 'tournament') {
      let bf = bubbleFactor(t, p, mainAggressor(t, p));
      bf = 1 + (bf - 1) * P.icmAware;
      need = (bf * call) / (bf * call + pot);
    }
    need *= 1.12 - 0.3 * P.x; // 松的玩家更愿意跟
    if (eq >= need) {
      if (ctx.canRaise && (preferShove || eq > 0.5 + 0.08 * opps.length)) return raiseTo(t, ctx, ctx.maxTo);
      return CALL;
    }
    return FOLD;
  }

  /* ---------------- 翻前 ---------------- */
  function preflop(t, p, ctx, P) {
    const h = t.hand, r = t.rng, bb = t.bb;
    // 技术越低，对起手牌强弱的判断越“随缘”
    const pct = clamp(Preflop.pct(p.hole[0], p.hole[1]) + (r() - 0.5) * 0.1 * (P.noise || 0), 0, 1);
    const pos = t.positionOf(p);
    const raises = h.preflopRaises;
    const tour = t.mode === 'tournament';
    const effBB = effectiveStack(t, p) / bb;
    const limpers = h.actions.filter((a) => a.street === 'preflop' && a.type === 'call' && a.facing === 0).length;
    const lateMul = pos.isBB ? 1 : pos.isSB ? 0.8 : 0.55 + 0.85 * pos.lateness;
    const maniac = P.x > 0.8 && P.y > 0.8;

    // 面对大额投入（>=35% 筹码）或全下：用胜率判断
    if (raises > 0 && ctx.toCall >= 0.35 * (p.stack + p.bet)) {
      return callOff(t, p, ctx, P, tour && effBB <= P.pushBB + 5);
    }

    // 锦标赛短筹码：推/弃
    if (tour && effBB <= P.pushBB) {
      if (raises === 0) {
        const late = pos.isSB ? 1.15 : pos.isBB ? 1 : 0.3 + 0.7 * pos.lateness;
        const shove = Math.min(1, (4 / Math.max(1, effBB)) * late * (0.55 + 0.45 * P.x + 0.35 * P.y) * (1 - 0.25 * bubblePressure(t) * P.icmAware));
        if (pct <= shove) {
          if (P.y < 0.35 && r() < 0.3 && !pos.isBB) return CALL; // 被动玩家短码溜入
          return raiseTo(t, ctx, ctx.maxTo);
        }
        if (pos.isBB && ctx.toCall === 0) return CHECK;
        if (P.y < 0.35 && pct <= P.vpip * 0.7 && r() < P.limpRate * 0.4) return CALL;
        return checkOrFold(ctx);
      }
      const reshove = Math.min(1, (2.2 / Math.max(1, effBB)) * (0.5 + 0.4 * P.y + 0.3 * P.x));
      if (pct <= reshove) return raiseTo(t, ctx, ctx.maxTo);
      return callOff(t, p, ctx, P, true);
    }

    const pressure = tour ? bubblePressure(t) : 0;
    let icmMul = 1;
    if (pressure > 0) {
      // 泡沫期：短码/紧弱玩家收紧，大码凶的玩家加宽施压
      const avg = t.players.reduce((s, q) => s + q.stack, 0) / Math.max(1, aliveTourPlayers(t).length);
      const big = (p.stack + p.bet) > avg * 1.3;
      icmMul = big ? 1 + 0.45 * pressure * P.y : 1 - 0.35 * pressure * P.icmAware;
    }

    if (raises === 0) {
      // 1.25 / 1.3 为校准系数：面对加注时会少玩很多牌，未开池时需要更宽才能让整体 VPIP/PFR 接近目标
      let open = Math.min(1, P.vpip * 1.25 * lateMul * icmMul);
      let rais = Math.min(1, P.pfr * 1.3 * lateMul * icmMul);
      if (limpers === 0 && pos.lateness >= 0.66 && !pos.isBB) {
        rais = Math.min(1, rais + P.steal * 0.35 * pos.lateness);
        open = Math.max(open, rais);
      }
      if (limpers > 0) open = Math.min(1, open * 1.15); // 有人溜入，赔率更好
      if (pct <= rais) {
        let size;
        if (maniac) size = bb * (3.5 + r() * 2);
        else if (tour) size = bb * (2.0 + 0.4 * P.y + r() * 0.3);
        else size = bb * (2.2 + 0.7 * P.y + r() * 0.5);
        if (pos.isSB) size += bb * 0.5;
        size += limpers * bb * (0.8 + 0.4 * P.y);
        return raiseTo(t, ctx, size);
      }
      if (pct <= open) {
        if (pos.isBB && ctx.toCall === 0) return CHECK;
        if (r() < P.limpRate + 0.1 || (limpers > 0 && r() < P.limpRate + 0.4)) return CALL;
        if (r() < P.y * 0.6) return raiseTo(t, ctx, bb * (2.3 + 0.6 * P.y) + limpers * bb);
        return checkOrFold(ctx);
      }
      return checkOrFold(ctx);
    }

    const raiser = t.players.find((q) => q.id === h.preflopAggressor);
    const raiserPos = raiser ? t.positionOf(raiser) : { lateness: 0.5 };
    const stealAdj = raiserPos.lateness >= 0.66 && !raiserPos.isBB ? 1.3 : 1;
    const raiseBB = t.currentBet / bb;
    const ip = pos.index === 0 || (!pos.isSB && !pos.isBB && pos.index < (raiserPos.index ?? 0));

    if (raises === 1) {
      const sizeMul = clamp(3 / Math.max(2, raiseBB - limpers), 0.35, 1.2);
      const coldCallers = h.actions.filter((a) => a.street === 'preflop' && a.type === 'call' && a.facing === 1).length;
      const tb = P.threeBet * (pos.isBB || pos.isSB ? 0.9 : 0.7 + 0.6 * pos.lateness) * stealAdj * icmMul;
      let callR = P.vpip * (0.5 + 0.45 * (1 - P.y)) * sizeMul * stealAdj * (pos.isBB ? 1.5 : 1) * (ip ? 1.1 : 0.85) * icmMul;
      if (coldCallers > 0) callR *= 1.1;
      if (pct <= tb) {
        const mult = ip ? 3 : 3.7;
        return raiseTo(t, ctx, t.currentBet * mult + coldCallers * t.currentBet);
      }
      if (pct <= tb + callR) return CALL;
      if (pct < 0.55 && r() < P.bluffRaise * 1.2 * stealAdj) return raiseTo(t, ctx, t.currentBet * (ip ? 3 : 3.7));
      return FOLD;
    }

    if (raises === 2) {
      const fb = P.fourBet * icmMul;
      const callR = P.vpip * 0.16 * (0.6 + P.x) * icmMul;
      if (pct <= fb) return raiseTo(t, ctx, t.currentBet * 2.3);
      if (pct <= fb + callR) return CALL;
      if (P.y > 0.7 && pct < 0.35 && r() < P.bluffRaise * 0.6) return raiseTo(t, ctx, t.currentBet * 2.3);
      return FOLD;
    }

    if (pct <= 0.02 + 0.015 * P.y) return raiseTo(t, ctx, ctx.maxTo);
    if (pct <= 0.035 + 0.03 * P.x) return CALL;
    return FOLD;
  }

  /* ---------------- 翻后 ---------------- */
  function postflop(t, p, ctx, P) {
    const h = t.hand, r = t.rng;
    const others = t.inHandPlayers().filter((q) => q !== p);
    const opps = others.map((q) => oppRange(t, q, p));
    const nOpp = opps.length;
    // 技术越低，对自己牌力的估计误差越大（高估/低估）
    const eq = clamp(Equity.equity(p.hole, t.board, opps, eqIters(t, nOpp, P), t.rng) + (r() - 0.5) * 0.3 * (P.noise || 0), 0, 1);
    const share = eq * (nOpp + 1);
    const pot = ctx.pot, toCall = ctx.toCall;
    const d = drawInfo(p.hole, t.board);
    const hasDraw = d.flushDraw || d.straightDraw === true;
    const madeCat = evaluate(p.hole.concat(t.board)) >> 20;
    const boardCat = evaluate(t.board) >> 20;
    const realHand = madeCat > boardCat;
    const isPfAggr = h.preflopAggressor === p.id;
    const order = h.order;
    const rankOf = (q) => { const i = order.indexOf(q.id); return i === 0 ? order.length : i; };
    const ip = others.every((q) => rankOf(q) < rankOf(p));
    const frac = () => clamp(P.betSize + (r() - 0.5) * 0.25, 0.25, 1.6);
    const streets = ['preflop', 'flop', 'turn', 'river'];
    const prevStreet = streets[streets.indexOf(t.street) - 1];
    let prevAggr = null;
    for (const a of h.actions) if (a.street === prevStreet && (a.type === 'bet' || a.type === 'raise')) prevAggr = a.pid;
    const tour = t.mode === 'tournament';

    // 针对性调整（只有 adapt 高的玩家会做）：对跟注站少诈唬、薄价值；对爱诈唬的人放宽跟注
    const A = P.adapt;
    let ftbSum = 0;
    for (const q of others) {
      const s = q.stats;
      ftbSum += (s.postFold + 0.42 * 12) / (s.postFold + s.postCall + 12);
    }
    const ftb = ftbSum / Math.max(1, others.length);
    const bluffMul = clamp(1 + A * 1.6 * (ftb / 0.42 - 1), 0.2, 1.8);
    const valueShare = P.valueShare - 0.12 * P.skill - A * 0.25 * clamp((0.42 - ftb) / 0.15, -1, 1);

    if (toCall === 0) {
      if (share >= valueShare) {
        if (eq > 0.85 && t.street !== 'river' && r() < P.slowplay) return CHECK;
        return raiseTo(t, ctx, pot * frac() * (eq > 0.8 ? 1.1 : 1));
      }
      if (t.street === 'flop' && isPfAggr) {
        const cb = P.cbet * (nOpp === 1 ? 1 : nOpp === 2 ? 0.6 : 0.35) * Math.sqrt(bluffMul);
        if (r() < cb) return raiseTo(t, ctx, pot * clamp(P.betSize * 0.8 + (r() - 0.5) * 0.2, 0.25, 1.2));
      }
      if (prevAggr === p.id && t.street !== 'flop') {
        const barrel = P.cbet * 0.55 * (hasDraw ? 1.4 : 1) * (share > 0.8 ? 1.3 : 0.8) * bluffMul / nOpp;
        if (r() < barrel) return raiseTo(t, ctx, pot * frac());
      }
      let bl = P.bluff * (hasDraw ? 2.2 : 1) * (nOpp === 1 ? 1 : 0.45) * (ip ? 1.3 : 0.9) * bluffMul;
      if (r() < bl) return raiseTo(t, ctx, pot * frac());
      return CHECK;
    }

    // 面对下注
    if (share >= P.raiseShare && ctx.canRaise) {
      if (r() < 0.3 + 0.6 * P.y) return raiseTo(t, ctx, t.currentBet + (pot + toCall) * clamp(0.6 + 0.4 * P.y + (r() - 0.5) * 0.2, 0.5, 1.2));
      return CALL;
    }
    if (ctx.canRaise && t.street !== 'river' && hasDraw && r() < P.bluffRaise * 1.8 * bluffMul) {
      return raiseTo(t, ctx, t.currentBet + (pot + toCall) * 0.75);
    }
    if (ctx.canRaise && nOpp === 1 && r() < P.bluffRaise * 0.4 * bluffMul) {
      return raiseTo(t, ctx, t.currentBet + (pot + toCall) * 0.8);
    }
    // 技术高的玩家跟注阈值更接近数学上的底池赔率，风格偏差变小
    const callLoose = P.callLoose + (1 - P.callLoose) * 0.6 * P.skill;
    let need = (toCall / (pot + toCall)) * callLoose;
    if (hasDraw && t.street !== 'river') need *= 0.85;
    const bettor = mainAggressor(t, p);
    if (bettor && A > 0) {
      const bs = bettor.stats;
      const bluffy = (bs.postBR + 0.3 * 12) / (bs.postBR + bs.postCall + bs.postFold + 12);
      need *= clamp(1 - A * 0.9 * (bluffy - 0.35), 0.7, 1.25); // 对爱诈唬的人放宽，对只在有牌时下注的人收紧
    }
    if (P.sticky > 0.35 && realHand && toCall < pot * 1.3) need *= 1 - 0.6 * P.sticky;
    if (tour && toCall > 0.3 * (p.stack + p.bet)) {
      let bf = bubbleFactor(t, p, mainAggressor(t, p));
      bf = 1 + (bf - 1) * P.icmAware;
      need = Math.max(need, ((bf * toCall) / (bf * toCall + pot)) * callLoose);
    }
    if (eq >= need) return CALL;
    if (r() < 0.03 * P.x) return CALL; // 偶尔的“好奇心跟注”
    return FOLD;
  }

  function decide(t, p, ctx) {
    if (!p.params) p.params = deriveParams(0.35, 0.7, t.size);
    const a = t.street === 'preflop' ? preflop(t, p, ctx, p.params) : postflop(t, p, ctx, p.params);
    if (a.type === 'fold' && ctx.toCall === 0) return CHECK;
    return a;
  }

  /* 给玩家的胜率提示 */
  function heroHint(t, p) {
    const opps = t.inHandPlayers().filter((q) => q !== p).map((q) => oppRange(t, q));
    const eq = Equity.equity(p.hole, t.board, opps, 1200, Math.random);
    return { eq, opps };
  }

  return { decide, heroHint, oppRange, bubbleFactor };
})();
