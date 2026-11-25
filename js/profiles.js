'use strict';
/* 玩家风格：二维坐标
 *   x 轴：紧(0) ←→ 松(1)        —— 决定 VPIP（入池率）
 *   y 轴：弱/被动(0) ←→ 凶/激进(1) —— 决定加注、下注、诈唬、持续下注频率
 */
const ARCHETYPES = {
  nit:       { name: '岩石',   en: 'Nit',             x: 0.07, y: 0.30 },
  weaktight: { name: '紧弱',   en: 'Weak-Tight',      x: 0.22, y: 0.14 },
  tag:       { name: '紧凶',   en: 'TAG',             x: 0.30, y: 0.74 },
  reg:       { name: '常规',   en: 'Reg',             x: 0.42, y: 0.60 },
  lag:       { name: '松凶',   en: 'LAG',             x: 0.62, y: 0.82 },
  maniac:    { name: '疯子',   en: 'Maniac',          x: 0.90, y: 0.95 },
  fish:      { name: '松弱鱼', en: 'Loose-Passive',   x: 0.66, y: 0.26 },
  station:   { name: '跟注站', en: 'Calling Station', x: 0.88, y: 0.07 },
};

const POOLS = {
  live_low: {
    name: '线下小额娱乐局', desc: '大量跟注站、松弱鱼，诈唬少、跟注多',
    w: { station: 3, fish: 3.5, weaktight: 1.5, nit: 1.5, tag: 0.8, reg: 0.4, lag: 0.5, maniac: 0.6 },
  },
  online_micro: {
    name: '线上微级别', desc: '鱼和紧弱玩家混杂，少量常规玩家',
    w: { fish: 2.5, station: 1.2, weaktight: 1.8, nit: 1.2, tag: 2, reg: 1.5, lag: 0.7, maniac: 0.3 },
  },
  online_mid: {
    name: '线上中级别', desc: '紧凶/常规玩家为主，鱼较少，竞争激烈',
    w: { tag: 3, reg: 3, lag: 2, nit: 1, weaktight: 0.5, fish: 0.7, station: 0.3, maniac: 0.2 },
  },
  home: {
    name: '家庭局 / 朋友局', desc: '人人都爱看翻牌，疯子与跟注站并存',
    w: { maniac: 2, station: 2.2, fish: 2.5, lag: 1.2, weaktight: 0.5, tag: 0.4 },
  },
  mixed: {
    name: '均衡混合', desc: '每种风格出现概率相同',
    w: { nit: 1, weaktight: 1, tag: 1, reg: 1, lag: 1, maniac: 1, fish: 1, station: 1 },
  },
  random: { name: '完全随机', desc: '在整个风格平面上均匀随机', w: null },
};

const NICKNAMES = [
  '老王', '阿杰', '小美', '大熊', '张总', 'Lucky7', '河牌王', '飞鱼', '北极狐', '阿Ken', 'Mike', '老李',
  '翻牌侠', 'AllinBoy', '静水', '赵姐', '牌桌诗人', '夜猫', 'TonyB', '小刀', '胖虎', '王哥', '咖啡', '老周',
  'Rainman', '红桃Q', '石头', 'Viper', '跟到底', 'Sakura', '阿飞', '豆豆', 'JackAce', '陈工', '慢打', '冲锋号',
];

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function classifyStyle(x, y) {
  if (x >= 0.78 && y >= 0.82) return '疯子';
  if (x >= 0.74 && y <= 0.2) return '跟注站';
  if (x <= 0.12) return y >= 0.6 ? '紧凶(极紧)' : '岩石';
  const loose = x >= 0.45;
  const aggr = y >= 0.5;
  if (loose && aggr) return '松凶';
  if (loose) return '松弱';
  if (aggr) return '紧凶';
  return '紧弱';
}

/* skill（技术，0..1）与风格独立：决定是否会针对对手调整、以及判断失误（噪声）的大小 */
function deriveParams(x, y, tableSize, skill) {
  const sizeMul = tableSize >= 8 ? 0.78 : 1;
  if (skill == null) skill = clamp01(1 - Math.abs(x - 0.35) * 1.6) * y;
  const vpip = (0.10 + 0.55 * x) * sizeMul;
  const pfrRatio = 0.12 + 0.83 * y;
  return {
    x, y,
    vpip,
    pfr: vpip * pfrRatio,
    threeBet: 0.015 + 0.10 * y * (0.4 + 0.6 * x),
    fourBet: 0.018 + 0.03 * y,
    cbet: 0.25 + 0.65 * y,
    bluff: 0.015 + 0.40 * y * y * (0.35 + 0.65 * x),
    bluffRaise: 0.008 + 0.16 * y * y * (0.3 + 0.7 * x),
    valueShare: 1.45 - 0.4 * y,    // 下注价值所需的“相对胜率份额”
    raiseShare: 1.75 - 0.42 * y,
    // 适应能力：会思考的玩家（紧凶/常规/松凶）根据 HUD 针对对手调整，鱼和疯子基本不调整
    skill,
    adapt: skill,
    noise: 1 - skill,
    callLoose: 1.28 - 0.62 * x,    // 跟注所需胜率 = 底池赔率 × 该系数
    sticky: x * (1 - y),           // 跟注站程度：有对子就很难弃
    limpRate: 0.9 * (1 - y),       // 未加注底池中非加注牌溜入的比例
    steal: 0.05 + 0.45 * y * (0.3 + 0.7 * x),
    betSize: 0.45 + 0.3 * y + (x > 0.8 && y > 0.8 ? 0.35 : 0),
    slowplay: 0.4 * (1 - y),
    pushBB: 8 + 7 * y,             // 锦标赛进入推/弃模式的有效筹码(BB)
    icmAware: 1.15 - 0.6 * x + 0.25 * (1 - y), // 对 ICM / 泡沫压力的敏感度
  };
}

function samplePoolStyle(poolId, rng = Math.random) {
  const pool = POOLS[poolId] || POOLS.mixed;
  if (!pool.w) {
    const x = rng(), y = rng();
    return { x, y, arch: null };
  }
  const entries = Object.entries(pool.w);
  const tot = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * tot, pick = entries[0][0];
  for (const [k, w] of entries) { r -= w; if (r <= 0) { pick = k; break; } }
  const a = ARCHETYPES[pick];
  return {
    x: clamp01(a.x + (rng() - 0.5) * 0.14),
    y: clamp01(a.y + (rng() - 0.5) * 0.14),
    arch: pick,
  };
}

function pickNames(n, rng = Math.random) {
  const pool = NICKNAMES.slice();
  Cards.shuffle(pool, rng);
  return pool.slice(0, n);
}
