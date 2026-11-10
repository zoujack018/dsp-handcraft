// 英文模式的翻译：页面照旧只出中文，这里按「中文原文 → 英文」的词典把出现在页面上的字翻过去。
// 词典的键是中文原文，带 {0}、{1} 的是句式（占位符处是运行时代进去的数、物品名或别的片段，取出来再各自翻）。
//
// 一段字的翻法：整段查词典；查不到就按标点一层一层来（句号分号 → 间隔号 → 冒号 → 逗号 → 顿号，括号里的不算）：
// 这段字里有某一层的标点时，只试字面里也带这层标点的句式，配不上就在这层标点处拆开、各自再翻。这样短句式
// （「喷{0}」）吞不掉整句（「喷增产剂：不增产」）。哪层标点都没有了才试全部句式，再不行把认识的词换掉。
// 页面上的句子常是几截拼的：以逗号、顿号这类开头的键算「接在后面的一截」，前面可以还有别的；以它们结尾的算「接在前面的一截」。
export const CJK = /[\u3400-\u9fff]/;

const TOKEN_0 = 0xe000; // 物品名先换成私用区的单个字符，句式的占位符就不会从名字中间劈开
const TOKEN = /[\ue000-\uf8ff]/g;
const PLACEHOLDER = /\{(\d+)\}/g;
const IS_PLACEHOLDER = /^\{\d+\}$/;
const PRE = '97'; // 「接在后面的一截」前面那段、「接在前面的一截」后面那段，在英文里的占位符编号
const POST = '98';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export const normKey = (s) => s.replace(/\s+/g, ' ').trim(); // \s 含不换行空格：游戏数据里的名字带着它，一律当普通空格

const LEVELS = ['。；！？\n', '·', '：', '，', '、']; // 标点从大到小；第 0 层（一句完了）拆开时标点跟着前一句
const OPEN = '（「(';
const CLOSE = '）」)';
const LABEL_BREAK = /[，：。；]/;
const LAST_STOP = /^([\s\S]*\S)\s*([。；！？])$/;
const TAIL_START = /^[，；。、：·（]/;
const HEAD_END = /[，、：；]$/;
const LAST_SPLITS = [/([（）「」])/, /( )/];
const PUNCT = [
  [/，/g, ', '],
  [/。/g, '. '],
  [/：/g, ': '],
  [/；/g, '; '],
  [/、/g, ', '],
  [/！/g, '! '],
  [/？/g, '? '],
  [/（/g, ' ('],
  [/）/g, ') '],
  [/[「『]/g, ' "'],
  [/[」』]/g, '" '],
  [/　/g, ' '],
];
const tidy = (s) => {
  for (const [re, to] of PUNCT) s = s.replace(re, to);
  return s
    .replace(/ ?· ?/g, ' · ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.;:!?)%])/g, '$1')
    .replace(/\( /g, '(')
    .replace(/[,;:] ?(?=[,.;:)])/g, '')
    .replace(/ +\n/g, '\n');
};

// 在括号外面的某一层标点处拆开：返回 [片段, 标点, 片段, …]，没有这层标点返回 null。
// 第 0 层的标点后面没字了（句末）不算；拆开时标点并进前一个片段，返回的全是片段
function splitAt(p, level) {
  const marks = LEVELS[level];
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && marks.includes(c)) {
      if (level === 0) {
        if (!/\S/.test(p.slice(i + 1))) break;
        out.push(p.slice(from, i + 1));
      } else out.push(p.slice(from, i), c);
      from = i + 1;
    }
  }
  if (!out.length) return null;
  out.push(p.slice(from));
  return out;
}

export function createTranslator({ dicts, names: rawNames }) {
  const names = Object.fromEntries(Object.entries(rawNames).map(([k, v]) => [normKey(k), v]));
  // 物品、建筑、配方名：长的先换；单个字的（氢、水）只在两边都不是汉字时才算
  const nameList = Object.keys(names).sort((a, b) => b.length - a.length);
  const tokenOf = new Map(nameList.map((n, i) => [n, String.fromCharCode(TOKEN_0 + i)]));
  const nameRe = nameList.length ? new RegExp(nameList.map(escapeRe).join('|'), 'g') : null;
  const protect = (s) =>
    nameRe
      ? s.replace(nameRe, (m, at) => {
          if (m.length === 1 && (CJK.test(s[at - 1] || '') || CJK.test(s[at + 1] || ''))) return m;
          return tokenOf.get(m);
        })
      : s;
  const nameAt = (c) => nameList[c.charCodeAt(0) - TOKEN_0];
  const toEnglish = (s) => s.replace(TOKEN, (c) => names[nameAt(c)] ?? c);
  const toChinese = (s) => s.replace(TOKEN, (c) => nameAt(c) ?? c); // 查整段词典用：词典的键是原文

  const exact = new Map();
  const byKey = new Map(); // 同一个键后进的词典盖掉先进的
  for (const dict of dicts) for (const [k, en] of Object.entries(dict)) byKey.set(normKey(k), en);
  const patterns = [];
  for (const [key, en] of byKey) {
    const parts = protect(key).split(/(\{\d+\})/).filter((p) => p !== '');
    const literal = parts.filter((p) => !IS_PLACEHOLDER.test(p)).join('');
    const plain = parts.length === 1 && !IS_PLACEHOLDER.test(parts[0]);
    if (plain) exact.set(key, en);
    if (!literal.trim()) continue; // 光有占位符的句式什么都能配上，不要
    // 紧挨着的几个占位符并成一个：英文里它们也照样挨着时整段搬过去，不然全算给第一个
    let value = en;
    let body = '';
    const order = [];
    const labels = []; // 后面紧跟冒号的占位符：是个标签，取出来的值里不该再有逗号、冒号、句号
    for (let i = 0; i < parts.length; i++) {
      if (!IS_PLACEHOLDER.test(parts[i])) {
        body += escapeRe(parts[i]);
        continue;
      }
      const run = [parts[i]];
      while (i + 1 < parts.length && IS_PLACEHOLDER.test(parts[i + 1])) run.push(parts[++i]);
      if (run.length > 1) {
        if (value.includes(run.join(''))) value = value.replace(run.join(''), run[0]);
        for (const other of run.slice(1)) value = value.split(other).join('');
      }
      order.push(run[0].slice(1, -1));
      if ((parts[i + 1] || '').startsWith('：')) labels.push(run[0].slice(1, -1));
      body += '([\\s\\S]*?)';
    }
    // 字面里的汉字越多越具体，先试；标点、单位只算零头
    const weight = [...literal].filter((c) => CJK.test(c)).length * 4 + literal.length;
    // 字面里带哪几层标点；第 0 层要标点后面还有东西才算（只在句末带个句号的句式管不了两句话）
    const levels = LEVELS.map((marks, l) => [...marks].some((c) => (l ? literal.includes(c) : key.includes(c) && key.indexOf(c) < key.length - 1)));
    const add = (re, val, ids, w) => {
      const group = Object.fromEntries(ids.map((id, g) => [id, g + 1]));
      patterns.push({ re: new RegExp(re), en: val, group, weight: w, levels, labels: labels.map((id) => group[id]) });
    };
    if (!plain) add(`^${body}$`, value, order, weight);
    if (TAIL_START.test(parts[0])) add(`^([\\s\\S]+?)${body}$`, `{${PRE}}${value}`, [PRE, ...order], weight - 0.5);
    if (HEAD_END.test(parts[parts.length - 1])) add(`^${body}([\\s\\S]+)$`, `${value}{${POST}}`, [...order, POST], weight - 0.5);
  }
  patterns.sort((a, b) => b.weight - a.weight);
  const spanning = LEVELS.map((_, l) => patterns.filter((p) => p.levels[l]));

  // 最后一招用的词表：不带占位符、两个字以上的词典条目，长的先换
  let glossRe = null;
  const gloss = (p) => {
    if (!glossRe) {
      const words = [...exact.keys()].filter((k) => k.length >= 2 && CJK.test(k)).sort((a, b) => b.length - a.length);
      glossRe = words.length ? new RegExp(words.map(escapeRe).join('|'), 'g') : /(?!)/g;
    }
    return p.replace(glossRe, (m) => ` ${exact.get(m)} `);
  };

  const whole = (p) => {
    const zh = toChinese(p);
    return exact.get(zh) ?? names[zh];
  };
  const apply = (list, p, depth) => {
    for (const pat of list) {
      const m = pat.re.exec(p);
      if (!m || pat.labels.some((g) => LABEL_BREAK.test(m[g]))) continue;
      return pat.en.replace(PLACEHOLDER, (all, i) => (pat.group[i] ? piece(m[pat.group[i]], depth + 1) : ''));
    }
    return null;
  };
  // 翻一段已经把名字换成记号的字，返回的还带着记号和中文标点
  function core(p, depth) {
    if (!CJK.test(p)) return p;
    const hit = whole(p);
    if (hit != null) return hit;
    if (depth > 10) return gloss(p);
    const sentences = splitAt(p, 0);
    if (sentences) {
      const spanned = apply(spanning[0], p, depth);
      if (spanned != null) return spanned;
      // 相邻几句并起来正好是词典里的一条（「…再试；还不行就…。」）时整条翻，别的一句一句来
      let out = '';
      for (let i = 0; i < sentences.length; ) {
        let j = sentences.length;
        let run = null;
        for (; j > i + 1; j--) {
          const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(sentences.slice(i, j).join(''));
          const hit = whole(m[2]);
          if (hit != null) {
            run = m[1] + hit + m[3];
            break;
          }
        }
        out += run ?? piece(sentences[i], depth + 1);
        i = run == null ? i + 1 : j;
      }
      return out;
    }
    // 一句话：有哪层标点就只试带这层标点的句式；配不上先把句末的标点拿掉再试，还不行才在这层标点处拆开
    let parts = null;
    let l = 1;
    for (; l < LEVELS.length; l++) if ((parts = splitAt(p, l))) break;
    const matched = apply(parts ? spanning[l] : patterns, p, depth);
    if (matched != null) return matched;
    const end = LAST_STOP.exec(p);
    if (end) return core(end[1], depth + 1) + end[2];
    if (parts) return parts.map((x, i) => (i % 2 ? x : piece(x, depth + 1))).join('');
    for (const sep of LAST_SPLITS) {
      const parts = p.split(sep);
      if (parts.length > 1) return parts.map((x, i) => (i % 2 ? x : piece(x, depth + 1))).join('');
    }
    return gloss(p);
  }
  function piece(x, depth) {
    if (!CJK.test(x)) return x;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(x);
    return m[1] + core(m[2], depth) + m[3];
  }

  const missing = new Set();
  const cache = new Map();
  // quiet：试着翻（整行连标签），翻不干净不算漏
  function translate(text, quiet = false) {
    if (!CJK.test(text)) return text;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const key = m[2].replace(/[ \t\r\f\v\u00a0]*\n[ \t\r\f\v\u00a0]*/g, '\n').replace(/[ \t\r\f\v\u00a0]+/g, ' ');
    let out = cache.get(key);
    if (out == null) {
      const flat = key.replace(/\n/g, ' ');
      out = exact.get(flat) ?? names[flat];
      if (out == null) {
        out = tidy(toEnglish(core(protect(key), 0))).trim();
        if (CJK.test(out)) {
          if (quiet) return m[1] + out + m[3];
          missing.add(key);
        }
      }
      if (cache.size > 4000) cache.clear();
      cache.set(key, out);
    }
    return (/^[,.;:)]/.test(out) ? '' : m[1]) + out + m[3]; // 英文以逗号、右括号这类开头时，前面不留空格
  }

  return { translate, missing, size: { exact: exact.size, patterns: patterns.length, names: nameList.length } };
}
