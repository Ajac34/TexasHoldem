'use strict';
/* 玩家数据库：身份（刻板印象）、风格、技术、程序生成的头像，存储在 localStorage */

const PERSONAS = {
  hoodie:    { name: '兜帽高玩', desc: '年轻职业牌手，读牌能力强，会针对你的漏洞调整', x: [0.30, 0.60], y: [0.68, 0.92], skill: [0.78, 0.97], w: [0.1, 0.5, 1.5, 3, 4, 5], fem: 0.12, age: [20, 32] },
  grinder:   { name: '职业磨王', desc: '每天十小时，紧凶稳健，很少犯错', x: [0.18, 0.36], y: [0.50, 0.75], skill: [0.62, 0.88], w: [0.3, 1, 2, 3, 3, 2.5], fem: 0.05, age: [28, 45] },
  boss:      { name: '老板', desc: '松凶、买入深、无限后手，输了就补', x: [0.70, 0.95], y: [0.72, 1.00], skill: [0.15, 0.45], w: [0.3, 1, 1.5, 1.5, 1.3, 1], fem: 0.05, age: [40, 60], deep: true },
  old_man:   { name: '退休大爷', desc: '只玩大牌，下注就是有货，很少诈唬', x: [0.02, 0.24], y: [0.08, 0.38], skill: [0.25, 0.55], w: [2.5, 2.5, 2, 1.3, 0.6, 0.3], fem: 0, age: [60, 78] },
  girl:      { name: '年轻女生', desc: '爱看翻牌，偏被动，喜欢跟注', x: [0.50, 0.80], y: [0.10, 0.42], skill: [0.10, 0.45], w: [2.5, 2.5, 1.5, 1, 0.5, 0.3], fem: 1, age: [20, 30] },
  aunt:      { name: '跟注阿姨', desc: '什么都跟，到河牌也不弃', x: [0.78, 0.96], y: [0.00, 0.15], skill: [0.03, 0.25], w: [3, 2, 1, 0.3, 0, 0], fem: 1, age: [48, 62] },
  tourist:   { name: '观光客', desc: '来玩玩的，松而被动，偶尔乱诈', x: [0.55, 0.85], y: [0.15, 0.50], skill: [0.05, 0.30], w: [3, 2.5, 1.5, 0.7, 0.3, 0.1], fem: 0.3, age: [30, 55] },
  student:   { name: '大学生', desc: '看了几个教学视频，松凶爱诈唬', x: [0.50, 0.80], y: [0.60, 0.90], skill: [0.20, 0.50], w: [2, 2, 1.5, 0.8, 0.3, 0.1], fem: 0.15, age: [19, 23] },
  office:    { name: '上班族', desc: '下班来放松，偏紧，有点怕输', x: [0.22, 0.45], y: [0.25, 0.60], skill: [0.30, 0.60], w: [2, 2, 2, 1.5, 0.8, 0.3], fem: 0.3, age: [25, 40] },
  rich_lady: { name: '富太太', desc: '不在乎输赢，高额桌的“提款机”', x: [0.55, 0.85], y: [0.15, 0.45], skill: [0.10, 0.35], w: [0, 0.3, 1, 1, 0.9, 0.7], fem: 1, age: [35, 55] },
};

const SURNAMES = '王李张刘陈杨黄赵周吴徐孙马朱胡郭何林罗高梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文';
const NAME_POOLS = {
  girl: ['小美', '甜甜', 'Lily', 'Coco', '小鹿', 'Vivian', '糖糖', 'Momo', 'Nana', '小雨', 'Kiki', 'Yuki', 'Amy', 'Zoe', '朵朵', '晴天', 'Luna', '芒果'],
  hoodie: ['RangeMerchant', 'cold4bet', 'River_Rat', 'NodeLock', 'Blocker仔', 'ICM_Ghost', 'overbet_kid', '3betKing', 'soul_read', 'minraise', 'ThinValue', 'polarized', 'checkraiser', 'HoodieAce', 'nitbuster', 'Exploit仔', 'MDF_Lord', 'GhostRange', 'tiltproof', 'SPR_zero'],
  grinder: ['老K', 'Grind24', '稳如狗', 'VPIP22', 'tightisright', 'EV_Hunter', '老司机', '冷静哥', '数据帝', '十万手', 'BRM大师', '夜班磨工'],
  tourist: ['Mike', 'Hans', 'Kenji', 'Pierre', 'Bob from Texas', 'Tom', 'Jake', 'Marco', 'Sven', 'Lucas', 'Dave'],
  touristF: ['Olga', 'Emma', 'Sophie', 'Ingrid', 'Chloe', 'Hanna', 'Mia'],
};

function pickFrom(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function lerp(a, b, t) { return a + (b - a) * t; }

function genName(persona, female, rng) {
  const s = SURNAMES[Math.floor(rng() * SURNAMES.length)];
  switch (persona) {
    case 'old_man': return pickFrom([`${s}大爷`, `老${s}`, `${s}伯`, `${s}老爷子`], rng);
    case 'aunt': return pickFrom([`${s}阿姨`, `${s}姐`, `${s}大妈`], rng);
    case 'boss': return pickFrom([`${s}总`, `${s}老板`, `${s}董`], rng);
    case 'rich_lady': return pickFrom([`${s}太太`, `${s}夫人`, `${s}姐`], rng);
    case 'girl': return pickFrom(NAME_POOLS.girl, rng);
    case 'hoodie': return pickFrom(NAME_POOLS.hoodie, rng);
    case 'grinder': return rng() < 0.4 ? `磨王${s}` : pickFrom(NAME_POOLS.grinder, rng);
    case 'student': return pickFrom([`大二${s}`, `学霸小${s}`, `研究生${s}`, `小${s}同学`, `翘课的${s}`], rng);
    case 'office': return pickFrom(female ? [`HR小${s}`, `会计${s}姐`, `产品${s}`] : [`程序员小${s}`, `会计老${s}`, `销售${s}`, `产品经理${s}`, `公务员老${s}`], rng);
    case 'tourist': return pickFrom(female ? NAME_POOLS.touristF : NAME_POOLS.tourist, rng);
  }
  return '玩家' + s;
}

const SKINS = ['#f6d7b8', '#eec29a', '#e0b08a', '#c58c62', '#8d5a3b'];
const HAIR_COLORS = { black: '#1e1a18', brown: '#5a3825', blonde: '#d8b26a', grey: '#a7a7a7', white: '#e4e4e4', red: '#7a2a1c', pink: '#e58fb0' };

function genAvatar(persona, female, age, rng) {
  const ch = (p) => rng() < p;
  const t = {
    skin: persona === 'tourist' ? pickFrom(SKINS, rng) : pickFrom(SKINS.slice(0, 3), rng),
    bg: pickFrom(['#3b4a5c', '#4a3b5c', '#3b5c4f', '#5c4a3b', '#2e4057', '#55405a'], rng),
    hair: 'short', hairColor: HAIR_COLORS.black, clothes: 'tshirt', color: '#3a6ea5', tie: null,
    glasses: false, sunglasses: false, headphones: false, cap: false, hoodUp: false, earrings: false,
    chain: false, cigar: false, beard: false, mustache: false, wrinkles: age >= 55, lipstick: female, pearls: false, dots: false,
  };
  if (female) t.hair = pickFrom(['long', 'ponytail', 'bun', 'long'], rng);
  if (age >= 60) t.hairColor = pickFrom([HAIR_COLORS.grey, HAIR_COLORS.white], rng);
  else if (ch(0.25)) t.hairColor = HAIR_COLORS.brown;
  switch (persona) {
    case 'hoodie':
      t.clothes = 'hoodie'; t.color = pickFrom(['#222831', '#37474f', '#4a148c', '#1b5e20', '#263238', '#5d4037'], rng);
      t.hoodUp = ch(0.6); t.headphones = ch(0.5); t.sunglasses = ch(0.3); t.cap = !t.hoodUp && ch(0.3);
      t.hair = female ? 'ponytail' : 'messy'; t.beard = !female && ch(0.2); break;
    case 'grinder':
      t.clothes = ch(0.4) ? 'hoodie' : 'tshirt'; t.color = pickFrom(['#455a64', '#263238', '#33691e', '#1a237e'], rng);
      t.cap = ch(0.6); t.sunglasses = ch(0.4); t.headphones = ch(0.3); t.beard = ch(0.35); break;
    case 'boss':
      t.clothes = 'suit'; t.color = pickFrom(['#111', '#1a237e', '#3e2723', '#212121'], rng);
      t.tie = pickFrom(['#c62828', '#f9a825', '#6a1b9a'], rng); t.hair = ch(0.3) ? 'bald' : 'slick';
      t.chain = ch(0.5); t.cigar = ch(0.35); t.glasses = ch(0.3); t.mustache = ch(0.3); t.bg = '#5c4a1e'; break;
    case 'old_man':
      t.clothes = 'cardigan'; t.color = pickFrom(['#6d4c41', '#757575', '#8d6e63', '#546e7a'], rng);
      t.hair = ch(0.5) ? 'bald' : 'short'; t.glasses = ch(0.7); t.mustache = ch(0.3); t.wrinkles = true; break;
    case 'girl':
      t.clothes = 'top'; t.color = pickFrom(['#f48fb1', '#ce93d8', '#fff1f6', '#90caf9', '#ffcc80'], rng);
      t.hairColor = pickFrom([HAIR_COLORS.black, HAIR_COLORS.brown, HAIR_COLORS.blonde, HAIR_COLORS.pink], rng);
      t.earrings = ch(0.6); break;
    case 'aunt':
      t.clothes = 'blouse'; t.dots = true; t.color = pickFrom(['#ad1457', '#6a1b9a', '#d84315', '#00695c'], rng);
      t.hair = 'curly'; t.hairColor = pickFrom([HAIR_COLORS.black, HAIR_COLORS.red], rng); t.earrings = ch(0.5); t.glasses = ch(0.3); break;
    case 'tourist':
      t.clothes = 'hawaiian'; t.color = pickFrom(['#00acc1', '#ff7043', '#43a047', '#fdd835'], rng);
      t.cap = ch(0.4); t.sunglasses = ch(0.4); t.hairColor = pickFrom([HAIR_COLORS.blonde, HAIR_COLORS.brown, HAIR_COLORS.red], rng);
      t.beard = !female && ch(0.25); break;
    case 'student':
      t.clothes = 'tshirt'; t.color = pickFrom(['#e53935', '#fb8c00', '#43a047', '#1e88e5', '#8e24aa'], rng);
      t.cap = ch(0.35); t.glasses = ch(0.4); t.headphones = ch(0.25); if (!female) t.hair = 'messy'; break;
    case 'office':
      t.clothes = 'shirt'; t.color = pickFrom(['#eceff1', '#bbdefb', '#e3f2fd'], rng);
      t.tie = female ? null : (ch(0.5) ? pickFrom(['#1565c0', '#37474f', '#ad1457'], rng) : null); t.glasses = ch(0.5); break;
    case 'rich_lady':
      t.clothes = 'dress'; t.color = pickFrom(['#b71c1c', '#111', '#c49b2d', '#4a148c'], rng);
      t.pearls = true; t.earrings = true; t.sunglasses = ch(0.25); t.hair = pickFrom(['long', 'bun'], rng);
      t.hairColor = pickFrom([HAIR_COLORS.black, HAIR_COLORS.brown, HAIR_COLORS.blonde], rng); break;
  }
  if (female) { t.beard = false; t.mustache = false; }
  return t;
}

function shade(hex, f) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const n = parseInt(c, 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('');
}

function avatarSVG(t, size = 56) {
  if (!t) return '';
  const hc = t.hairColor, sk = t.skin, cl = t.color, dk = shade(cl, 0.7);
  let s = `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="${t.bg}"/>`;
  // 背后：兜帽 / 长发
  if (t.hoodUp) s += `<ellipse cx="50" cy="46" rx="27" ry="31" fill="${cl}"/>`;
  if (!t.hoodUp && (t.hair === 'long')) s += `<path d="M29 46 Q27 18 50 18 Q73 18 71 46 L74 80 Q50 88 26 80 Z" fill="${hc}"/>`;
  if (!t.hoodUp && t.hair === 'ponytail') s += `<ellipse cx="70" cy="40" rx="7" ry="14" fill="${hc}"/>`;
  // 身体与衣服
  s += `<path d="M8 100 C10 80 28 72 50 72 C72 72 90 80 92 100 Z" fill="${cl}"/>`;
  s += `<rect x="44" y="58" width="12" height="16" fill="${shade(sk, 0.92)}"/>`;
  switch (t.clothes) {
    case 'hoodie':
      s += `<path d="M34 73 Q50 88 66 73" stroke="${dk}" stroke-width="4" fill="none"/>`;
      s += `<line x1="45" y1="80" x2="44" y2="92" stroke="#ddd" stroke-width="1.5"/><line x1="55" y1="80" x2="56" y2="92" stroke="#ddd" stroke-width="1.5"/>`;
      break;
    case 'suit':
      s += `<path d="M40 72 L50 96 L60 72 Z" fill="#fafafa"/>`;
      if (t.tie) s += `<path d="M48 76 L52 76 L54 91 L50 96 L46 91 Z" fill="${t.tie}"/>`;
      s += `<path d="M40 72 L46 90 M60 72 L54 90" stroke="${shade(cl, 1.6)}" stroke-width="1.2"/>`;
      break;
    case 'cardigan':
      s += `<path d="M42 72 L50 90 L58 72 Z" fill="#e8e2d0"/>`;
      for (const y of [86, 92, 98]) s += `<circle cx="50" cy="${y}" r="1.6" fill="${shade(cl, 0.5)}"/>`;
      s += `<line x1="50" y1="88" x2="50" y2="100" stroke="${dk}" stroke-width="1"/>`;
      break;
    case 'top':
    case 'dress':
      s += `<path d="M37 73 Q50 88 63 73 Z" fill="${shade(sk, 0.95)}"/>`;
      break;
    case 'blouse':
      s += `<path d="M42 73 L50 84 L58 73 Z" fill="${shade(sk, 0.95)}"/>`;
      break;
    case 'hawaiian':
      s += `<path d="M42 72 L50 82 L58 72" stroke="#fff" stroke-width="2" fill="none"/>`;
      for (const [x, y, c] of [[24, 88, '#fff176'], [38, 94, '#f06292'], [64, 90, '#fff176'], [78, 94, '#f06292'], [30, 98, '#fff']]) s += `<circle cx="${x}" cy="${y}" r="3.2" fill="${c}"/>`;
      break;
    case 'shirt':
      s += `<path d="M42 72 L47 80 L50 74 L53 80 L58 72" stroke="#90a4ae" stroke-width="1.5" fill="none"/>`;
      if (t.tie) s += `<path d="M48.5 78 L51.5 78 L53 92 L50 96 L47 92 Z" fill="${t.tie}" transform="rotate(8 50 85)"/>`;
      break;
    default:
      s += `<path d="M40 72 Q50 80 60 72" stroke="${dk}" stroke-width="2.5" fill="none"/>`;
  }
  if (t.dots) for (const [x, y] of [[22, 90], [34, 84], [66, 85], [78, 91], [28, 98], [72, 98]]) s += `<circle cx="${x}" cy="${y}" r="2.2" fill="#fff" opacity=".7"/>`;
  if (t.pearls) for (let k = 0; k <= 8; k++) { const a = Math.PI * (0.15 + 0.7 * k / 8); s += `<circle cx="${50 - 13 * Math.cos(a)}" cy="${70 + 11 * Math.sin(a)}" r="1.7" fill="#fdfdf5"/>`; }
  if (t.chain) s += `<path d="M38 74 Q50 90 62 74" stroke="#f2c230" stroke-width="2.2" fill="none"/>`;
  // 头
  s += `<circle cx="34" cy="47" r="4" fill="${sk}"/><circle cx="66" cy="47" r="4" fill="${sk}"/>`;
  s += `<ellipse cx="50" cy="45" rx="16" ry="19" fill="${sk}"/>`;
  // 头发
  if (!t.hoodUp) {
    switch (t.hair) {
      case 'short': s += `<path d="M33 43 Q31 22 50 22 Q69 22 67 43 Q63 30 50 30 Q37 30 33 43 Z" fill="${hc}"/>`; break;
      case 'messy': s += `<path d="M33 43 Q30 21 42 22 L45 17 L49 22 L54 16 L57 22 Q70 22 67 43 Q63 30 50 31 Q37 30 33 43 Z" fill="${hc}"/>`; break;
      case 'slick': s += `<path d="M33 40 Q33 21 50 21 Q67 21 67 40 Q62 27 50 27 Q38 27 33 40 Z" fill="${hc}"/><path d="M40 24 Q50 22 60 25" stroke="#fff" stroke-opacity=".35" stroke-width="1.5" fill="none"/>`; break;
      case 'bald': s += `<ellipse cx="34.5" cy="38" rx="3" ry="6" fill="${hc}"/><ellipse cx="65.5" cy="38" rx="3" ry="6" fill="${hc}"/><path d="M42 29 Q48 27 54 29" stroke="#fff" stroke-opacity=".4" stroke-width="2" fill="none"/>`; break;
      case 'long': case 'ponytail': case 'bun':
        s += `<path d="M33 42 Q34 21 50 21 Q66 21 67 42 Q60 29 47 31 Q39 33 33 42 Z" fill="${hc}"/>`;
        if (t.hair === 'bun') s += `<circle cx="50" cy="19" r="8" fill="${hc}"/>`;
        break;
      case 'curly':
        for (const [x, y] of [[36, 32], [42, 26], [50, 24], [58, 26], [64, 32], [34, 40], [66, 40], [46, 28], [55, 28]]) s += `<circle cx="${x}" cy="${y}" r="6" fill="${hc}"/>`;
        break;
    }
  } else {
    s += `<path d="M38 33 Q50 27 62 33 L60 36 Q50 31 40 36 Z" fill="${hc}"/>`;
    s += `<path d="M27 56 Q26 17 50 15 Q74 17 73 56" stroke="${dk}" stroke-width="5" fill="none"/>`;
  }
  if (t.wrinkles) s += `<path d="M42 34 Q50 32 58 34 M43 37 Q50 35.5 57 37" stroke="${shade(sk, 0.75)}" stroke-width="1" fill="none"/>`;
  // 帽子
  if (t.cap) s += `<path d="M33 37 Q33 18 50 18 Q67 18 67 37 Z" fill="${dk}"/><path d="M31 37 L72 37 Q78 39 72 41 L31 40 Z" fill="${shade(cl, 0.5)}"/>`;
  // 眼睛 / 眼镜
  const ey = 46;
  if (t.sunglasses) {
    s += `<rect x="37" y="${ey - 4}" width="11" height="7" rx="2.5" fill="#111"/><rect x="52" y="${ey - 4}" width="11" height="7" rx="2.5" fill="#111"/><line x1="48" y1="${ey - 2}" x2="52" y2="${ey - 2}" stroke="#111" stroke-width="1.5"/>`;
  } else {
    s += `<circle cx="43.5" cy="${ey}" r="1.9" fill="#222"/><circle cx="56.5" cy="${ey}" r="1.9" fill="#222"/>`;
    s += `<path d="M39.5 ${ey - 5} L46.5 ${ey - 5.5} M53.5 ${ey - 5.5} L60.5 ${ey - 5}" stroke="${t.hair === 'bald' ? '#777' : hc}" stroke-width="1.6"/>`;
    if (t.glasses) s += `<circle cx="43.5" cy="${ey}" r="5" fill="none" stroke="${t.clothes === 'suit' ? '#d4a52a' : '#333'}" stroke-width="1.4"/><circle cx="56.5" cy="${ey}" r="5" fill="none" stroke="${t.clothes === 'suit' ? '#d4a52a' : '#333'}" stroke-width="1.4"/><line x1="48.5" y1="${ey}" x2="51.5" y2="${ey}" stroke="#333" stroke-width="1.2"/>`;
  }
  // 鼻子 嘴
  s += `<path d="M50 48 L48.5 53 L51 53.5" stroke="${shade(sk, 0.75)}" stroke-width="1.1" fill="none"/>`;
  if (t.beard) s += `<path d="M35 50 Q36 66 50 66 Q64 66 65 50 Q62 60 50 60 Q38 60 35 50 Z" fill="${hc}" opacity=".85"/>`;
  if (t.mustache) s += `<path d="M44 56 Q50 53 56 56 Q50 55.5 44 56 Z" fill="${t.hair === 'bald' ? '#555' : hc}" stroke="${t.hair === 'bald' ? '#555' : hc}" stroke-width="1.5"/>`;
  s += t.lipstick ? `<path d="M46 58 Q50 61 54 58 Q50 59 46 58 Z" fill="#c2185b" stroke="#c2185b" stroke-width="1.3"/>`
    : `<path d="M46 58 Q50 ${t.persona === 'old_man' ? 57 : 60.5} 54 58" stroke="#7a3b2e" stroke-width="1.4" fill="none"/>`;
  if (t.cigar) s += `<rect x="53" y="58" width="13" height="3" rx="1" fill="#6d4c41" transform="rotate(10 53 58)"/><circle cx="66" cy="61" r="1.6" fill="#ff7043"/>`;
  if (t.earrings) s += `<circle cx="34" cy="53" r="1.8" fill="#f2c230"/><circle cx="66" cy="53" r="1.8" fill="#f2c230"/>`;
  if (t.headphones) {
    if (t.hoodUp) s += `<path d="M34 72 Q50 82 66 72" stroke="#111" stroke-width="3" fill="none"/><rect x="29" y="68" width="8" height="8" rx="2" fill="#111"/><rect x="63" y="68" width="8" height="8" rx="2" fill="#111"/>`;
    else s += `<path d="M31 46 Q30 16 50 16 Q70 16 69 46" stroke="#111" stroke-width="3.5" fill="none"/><rect x="27" y="41" width="8" height="12" rx="3" fill="#111"/><rect x="65" y="41" width="8" height="12" rx="3" fill="#111"/>`;
  }
  return s + '</svg>';
}

/* ---------------- 数据库 ---------------- */
const DB_KEY = 'thsim_playerdb_v1';
const PlayerDB = {
  data: null,
  load() {
    if (this.data) return this.data;
    try { const s = localStorage.getItem(DB_KEY); if (s) this.data = JSON.parse(s); } catch (e) { this.data = null; }
    if (!this.data || !this.data.players || !this.data.players.length) this.data = this.generate();
    return this.data;
  },
  save() { try { localStorage.setItem(DB_KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ } },
  generate(rng = Math.random) {
    const players = [];
    const used = new Set();
    let id = 1;
    for (let lv = 1; lv <= 6; lv++) {
      const entries = Object.entries(PERSONAS).filter(([, p]) => p.w[lv - 1] > 0);
      const tot = entries.reduce((s, [, p]) => s + p.w[lv - 1], 0);
      for (let k = 0; k < 22; k++) {
        let r = rng() * tot, key = entries[0][0];
        for (const [kk, p] of entries) { r -= p.w[lv - 1]; if (r <= 0) { key = kk; break; } }
        const P = PERSONAS[key];
        const female = rng() < P.fem;
        const age = Math.round(lerp(P.age[0], P.age[1], rng()));
        let name = genName(key, female, rng);
        let tries = 0;
        while (used.has(name) && tries++ < 20) name = genName(key, female, rng);
        if (used.has(name)) name += Math.floor(rng() * 90 + 10);
        used.add(name);
        // 约 12% 的玩家“反刻板印象”：外表是这个身份，打法却完全不同
        const atypical = rng() < 0.12;
        const x = atypical ? rng() : lerp(P.x[0], P.x[1], rng());
        const y = atypical ? rng() : lerp(P.y[0], P.y[1], rng());
        const skill = atypical ? lerp(0.3, 0.9, rng()) : lerp(P.skill[0], P.skill[1], rng());
        const avatar = genAvatar(key, female, age, rng);
        avatar.persona = key;
        players.push({ id: id++, name, persona: key, female, age, x, y, skill, home: lv, atypical, avatar, stats: null, handsWithHero: 0, sessionsWithHero: 0, notes: '' });
      }
    }
    return { version: 1, players };
  },
  byId(id) { return this.load().players.find((p) => p.id === id); },
  /* 按级别挑选对手：本级别玩家权重 3，相邻级别权重 1 */
  pick(level, n, excludeIds = new Set(), rng = Math.random) {
    const cands = this.load().players.filter((p) => !excludeIds.has(p.id) && Math.abs(p.home - level) <= 1);
    const res = [];
    const pool = cands.map((p) => ({ p, w: p.home === level ? 3 : 1 }));
    for (let k = 0; k < n && pool.length; k++) {
      const tot = pool.reduce((s, e) => s + e.w, 0);
      let r = rng() * tot, idx = 0;
      for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
      res.push(pool[idx].p); pool.splice(idx, 1);
    }
    return res;
  },
  reset() { this.data = this.generate(); this.save(); },
};

function personaLevelMix(level) {
  const items = Object.entries(PERSONAS).map(([k, p]) => [k, p.w[level - 1]]).filter(([, w]) => w > 0);
  const tot = items.reduce((s, [, w]) => s + w, 0);
  return items.map(([k, w]) => [k, w / tot]).sort((a, b) => b[1] - a[1]);
}
