// 高架段分层：在两两约束下给每段挑一层，长的段尽量低、短的段去高层（层数分布像金字塔：2 层够多了才有 3 层，3 层够多了才有 4 层）。
//
// 约束来自每段占的平面格子（升降那一叠占 1..L 层，RAMP_MAX_DZ = 0）：
// - 两段的水平部分经过同一格：不能同层（neq）；
// - 我的水平部分从你升降那一叠上空经过：我必须比你高（above）；
// - 两叠升降在同一格、或者互相都压在对方的叠上：怎么都放不下，短的那段算断开。
//
// 做法：按「必须比别人低的先排」的拓扑序，同等条件下长的先排，每段放到满足约束的最低层；
// 再反复做两种改进直到没有变化：能往下落就落；和一段比自己短、在自己下面、只是因为同格不能同层的段换层（长的往下）。
// 不做「放不下就把挡路的请出去重排」，所以不会来回打转。
//
// 约束表一律按 CSR 用：第 i 行是 adj[off[i] .. off[i + 1])，off[0] = 0，行内按加的先后、不重复。
// 下面这些临时表按线程复用（每个 worker 一份模块；solveLevels 不会重入，回调 fixedOk 不会再调它），不够大才换大的。

/** 按线程复用的缓冲区：a 够 size 长就原样用，不够换一个更大的同类型的（旧内容不要：用的人先写后读，或者自己清零） */
const room = (a, size) => (a.length >= size ? a : new a.constructor(Math.max(size, Math.ceil(a.length * 1.5))));
let levelBuf = new Int32Array(0);
let belowOff = new Int32Array(0);
let belowAdj = new Int32Array(0);
let deadBuf = new Uint8Array(0);
let indegBuf = new Int32Array(0);
let doneBuf = new Uint8Array(0);
let orderBuf = new Int32Array(0);
let liveBuf = new Int32Array(0);
// fit 用的
let idsBuf = new Int32Array(0);
let domOff = new Int32Array(0);
let domLen = new Int32Array(0);
let domBuf = new Int32Array(0);
let freeBuf = new Int32Array(0);
let isFreeBuf = new Uint8Array(0);
let posBuf = new Int32Array(0);
let clBuf = new Int32Array(0);
let wordBuf = new Int32Array(0); // 有冲突的段的位表（见 fitSearch）
let wcntBuf = new Int32Array(0);
let perBuf = new Int32Array(0);
let maskA = new Int32Array(0); // 段数不超过 32 时 fitSearch 按位找邻居（见那里）
let maskB = new Int32Array(0);
let maskN = new Int32Array(0);
let lvlBuf = new Int32Array(0);
let tabuBuf = new Int32Array(0);
let pickBuf = new Int32Array(0);
let bestBuf = new Int32Array(0);
let outBuf = new Uint8Array(0);
let stackBuf = new Int32Array(0);
let rowMark = new Int32Array(0); // toCsr 去重用：值 j 在这一行出现过就记这一行的戳
let rowStamp = 0;

/**
 * 按先后记下的 m 条边 E（第 t 条：行 E[2t]、值 E[2t + 1]，都在 0..n−1）排成 n 行的 CSR，写进 off（至少 n + 1 长）、adj（至少 m 长）。
 * 同一行按记下的先后放（计数排序是稳定的），重复的值只留第一次（和按同样的先后往每行的 Set 里 add 一样）。elevation.js 的 liftLegs 加完约束后调
 */
export function toCsr(n, E, m, off, adj) {
  off.fill(0, 0, n + 1);
  for (let t = 0; t < m; t++) off[E[2 * t] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  for (let t = 0; t < m; t++) adj[off[E[2 * t]]++] = E[2 * t + 1]; // t 递增着放：同一行里先记的在前
  for (let i = n; i > 0; i--) off[i] = off[i - 1]; // 放完 off[i] 停在第 i 行末尾（= 第 i + 1 行开头），挪回一位
  off[0] = 0;
  if (rowMark.length < n || rowStamp >= 2e9) {
    rowMark = new Int32Array(Math.max(n, rowMark.length));
    rowStamp = 0;
  }
  // 每行就地去重：往前挪（写的位置不超过读的位置），新的 off 跟着写
  let w = 0;
  for (let i = 0; i < n; i++) {
    const s = ++rowStamp;
    const a = off[i];
    const b = off[i + 1];
    off[i] = w;
    for (let t = a; t < b; t++) {
      const j = adj[t];
      if (rowMark[j] === s) continue;
      rowMark[j] = s;
      adj[w++] = j;
    }
  }
  off[n] = w;
}

/**
 * 约束表转成 CSR：已经是 { off, adj } 的原样用（elevation.js 直接给的）；Set 数组（测试在用）按每个 Set 的遍历顺序抄一遍，
 * 也就是插入顺序，Set 本来不重复。只在入口转一次，不复用缓冲区
 */
function csrOf(n, rows) {
  if (rows.off) return rows;
  let m = 0;
  for (let i = 0; i < n; i++) m += rows[i].size ?? rows[i].length;
  const off = new Int32Array(n + 1);
  const adj = new Int32Array(m);
  let t = 0;
  for (let i = 0; i < n; i++) {
    for (const j of rows[i]) adj[t++] = j;
    off[i + 1] = t;
  }
  return { off, adj };
}

/**
 * @param {number} n 段数
 * @param {object} o
 * @param {number[]} o.len 每段的格子数（权重）
 * @param {Set<number>[]|{off: Int32Array, adj: Int32Array}} o.neq 不能同层的段（Set 数组，或者 CSR：第 i 行是 adj[off[i] .. off[i + 1])，行内不重复）
 * @param {Set<number>[]|{off: Int32Array, adj: Int32Array}} o.above above[i] 里的段 i 都必须比它们高（格式同 neq）
 * @param {boolean[]} o.bad 怎么都放不下的段（自己走回头路、被物流站挡死……）
 * @param {(i: number, L: number) => boolean} o.fixedOk 第 L 层和已经固定的东西（物流站、形状随层变的段）不冲突
 * @param {number} o.maxLevel 不罚的最高层：贪心排出来超过它时先在这几层里找没有冲突的分配
 * @param {number} o.top 最高试到第几层（再高就算断开）
 * @returns {number[]} 每段的层，0 表示断开
 */
export function solveLevels(n, { len, neq, above, bad, fixedOk, maxLevel, top, onGreedy = null, hookCtx = null }) {
  // 算的时候用按线程复用的整数表，返回前抄成新数组
  const level = (levelBuf = room(levelBuf, n));
  level.fill(0, 0, n);
  const N = csrOf(n, neq);
  const A = csrOf(n, above);
  const nOff = N.off;
  const nAdj = N.adj;
  const aOff = A.off;
  const aAdj = A.adj;
  const dead = (deadBuf = room(deadBuf, n)); // 断开记 1，只按真假读
  for (let i = 0; i < n; i++) dead[i] = bad[i] ? 1 : 0;
  // below[j]：必须比 j 高的段（above 反过来），按 i 递增做计数排序放进去，每行按 i 递增、不重复
  belowOff = room(belowOff, n + 1);
  belowAdj = room(belowAdj, aOff[n]);
  const bOff = belowOff;
  const bAdj = belowAdj;
  bOff.fill(0, 0, n + 1);
  for (let t = 0; t < aOff[n]; t++) bOff[aAdj[t] + 1]++;
  for (let j = 0; j < n; j++) bOff[j + 1] += bOff[j];
  for (let i = 0; i < n; i++) for (let t = aOff[i]; t < aOff[i + 1]; t++) bAdj[bOff[aAdj[t]]++] = i;
  for (let j = n; j > 0; j--) bOff[j] = bOff[j - 1]; // 放完 bOff[j] 停在第 j 行末尾（= 第 j + 1 行开头），挪回一位
  bOff[0] = 0;
  // 拓扑序：必须比别人低的先排；能排的里面长的先排（一样长的按编号）。order[0..no) 按排的先后
  const indeg = (indegBuf = room(indegBuf, n));
  indeg.fill(0, 0, n);
  for (let i = 0; i < n; i++) if (!dead[i]) for (let t = aOff[i]; t < aOff[i + 1]; t++) if (!dead[aAdj[t]]) indeg[i]++;
  const done = (doneBuf = room(doneBuf, n));
  done.fill(0, 0, n);
  const order = (orderBuf = room(orderBuf, n));
  let no = 0;
  let left = 0;
  for (let i = 0; i < n; i++) if (!dead[i]) left++;
  while (left > 0) {
    let pick = -1;
    for (let i = 0; i < n; i++) if (!dead[i] && !done[i] && indeg[i] === 0 && (pick < 0 || len[i] > len[pick])) pick = i;
    if (pick < 0) {
      // 成环：剩下的里面断开最短的
      let s = -1;
      for (let i = 0; i < n; i++) if (!dead[i] && !done[i] && (s < 0 || len[i] < len[s])) s = i;
      dead[s] = 1;
      left--;
      for (let t = bOff[s]; t < bOff[s + 1]; t++) { const k = bAdj[t]; if (!dead[k] && !done[k]) indeg[k]--; }
      continue;
    }
    done[pick] = 1;
    order[no++] = pick;
    left--;
    for (let t = bOff[pick]; t < bOff[pick + 1]; t++) { const k = bAdj[t]; if (!dead[k] && !done[k]) indeg[k]--; }
  }
  /** 段 i 放在第 L 层和别的段有几处冲突（不算固定的东西） */
  const clash = (i, L) => {
    let c = 0;
    for (let t = aOff[i], e = aOff[i + 1]; t < e; t++) { const j = aAdj[t]; if (!dead[j] && L <= level[j]) c++; }
    for (let t = bOff[i], e = bOff[i + 1]; t < e; t++) { const k = bAdj[t]; if (!dead[k] && L >= level[k]) c++; }
    for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) { const m = nAdj[t]; if (!dead[m] && level[m] === L) c++; }
    return c;
  };
  /**
   * 贪心排出来超过 maxLevel 时：在 1..maxLevel 层里找没有冲突的分配（最小冲突局部搜索 fitSearch：挑一段有冲突的，挪到冲突最少的那层，
   * 刚离开的那层几步之内不回去）；找不到就取冲突最少的那次，冲突的段先拿掉（短的先拿），再从低往高找空层放回去。ids[0..nids) 按 order 的先后
   */
  const fit = (ids, nids) => {
    // 每段能挪的层：1..maxLevel 里 fixedOk 的，按 ids 的顺序依次排在 domBuf 里，段 i 的是 domBuf[domOff[i] .. + domLen[i])，层从低到高
    domOff = room(domOff, n);
    domLen = room(domLen, n);
    domBuf = room(domBuf, nids * maxLevel);
    const dOff = domOff;
    const dLen = domLen;
    const dBuf = domBuf;
    let dTop = 0;
    for (let q = 0; q < nids; q++) {
      const i = ids[q];
      dOff[i] = dTop;
      for (let L = 1; L <= maxLevel; L++) if (fixedOk(i, L)) dBuf[dTop++] = L;
      dLen[i] = dTop - dOff[i];
    }
    // 1..maxLevel 层都被固定的东西挡住的段只能升上去，不动它。free[0..nf) 按 ids 的顺序
    const free = (freeBuf = room(freeBuf, nids));
    let nf = 0;
    for (let q = 0; q < nids; q++) if (dLen[ids[q]]) free[nf++] = ids[q];
    for (let p = 0; p < nf; p++) {
      const i = free[p];
      if (level[i] <= maxLevel) continue;
      let b = 0;
      for (let t = dOff[i], e = t + dLen[i]; t < e; t++) { const L = dBuf[t]; if (!b || clash(i, L) < clash(i, b)) b = L; }
      level[i] = b;
    }
    // 每段当前的冲突数 cl[i] 和总数 tot 由 fitSearch 增量维护；有冲突的段按它在 free 里的位置 pos 记在位表里
    const isFree = (isFreeBuf = room(isFreeBuf, n));
    isFree.fill(0, 0, n);
    for (let p = 0; p < nf; p++) isFree[free[p]] = 1;
    // 段 -> 它在 free 里的位置（只给 free 里的段写；fitSearch 只按 free 里的段读）
    const pos = (posBuf = room(posBuf, n));
    for (let p = 0; p < nf; p++) pos[free[p]] = p;
    const cl = (clBuf = room(clBuf, n));
    cl.fill(0, 0, n);
    const nw = (nf + 31) >> 5;
    const words = (wordBuf = room(wordBuf, nw));
    const wcnt = (wcntBuf = room(wcntBuf, nw));
    words.fill(0, 0, nw);
    wcnt.fill(0, 0, nw);
    let tot = 0;
    let nBad = 0; // 有冲突（cl > 0）的段数
    for (let p = 0; p < nf; p++) {
      const i = free[p];
      const c = clash(i, level[i]);
      cl[i] = c;
      tot += c;
      if (c > 0) {
        nBad++;
        words[p >> 5] |= 1 << (p & 31);
        wcnt[p >> 5]++;
      }
    }
    const stride = maxLevel + 1;
    const tabu = (tabuBuf = room(tabuBuf, n * stride)); // 段 i 离开第 L 层后，第几步之前不回去（0 = 没禁）
    tabu.fill(0, 0, n * stride);
    // 冲突最少的那次分配（每次改进抄进同一张表）
    const best = (bestBuf = room(bestBuf, n));
    for (let i = 0; i < n; i++) best[i] = level[i];
    perBuf = room(perBuf, maxLevel + 2);
    pickBuf = room(pickBuf, maxLevel);
    // 段数不超过 32 时邻居按位记（fitSearch 挪段时按位找冲突数会变的邻居）：每段 above / below / neq 里没断开的邻居各一个字（第 j 位是段 j），
    // free 里的段一个字，lvl[L] 是现在在第 L 层（1..maxLevel）的段（没断开的）
    let fm = 0;
    if (n <= 32) {
      maskA = room(maskA, n);
      maskB = room(maskB, n);
      maskN = room(maskN, n);
      lvlBuf = room(lvlBuf, maxLevel + 1);
      for (let i = 0; i < n; i++) {
        let a = 0;
        let b = 0;
        let q = 0;
        if (!dead[i]) {
          for (let t = aOff[i]; t < aOff[i + 1]; t++) { const j = aAdj[t]; if (!dead[j]) a |= 1 << j; }
          for (let t = bOff[i]; t < bOff[i + 1]; t++) { const j = bAdj[t]; if (!dead[j]) b |= 1 << j; }
          for (let t = nOff[i]; t < nOff[i + 1]; t++) { const j = nAdj[t]; if (!dead[j]) q |= 1 << j; }
        }
        maskA[i] = a;
        maskB[i] = b;
        maskN[i] = q;
      }
      for (let p = 0; p < nf; p++) fm |= 1 << free[p];
      lvlBuf.fill(0, 0, maxLevel + 1);
      for (let i = 0; i < n; i++) if (!dead[i] && level[i] >= 1 && level[i] <= maxLevel) lvlBuf[level[i]] |= 1 << i;
    }
    const bestC = fitSearch(n, 100 + 30 * nids, (n * 2654435761) >>> 0, tot, nBad, free, dOff, dLen, dBuf, level, dead, isFree, pos, cl, words, wcnt, aOff, aAdj, bOff, bAdj, nOff, nAdj, maxLevel, perBuf, tabu, pickBuf, best, n <= 32, maskA, maskB, maskN, fm, lvlBuf);
    if (!bestC) return;
    // 拿掉的段连同必须比它高的段（一路往上）一起拿掉，再按拓扑序放回去：放回去时上面没有压着的段，总能往上找到层。
    // out 是标记，stack 按拿掉的先后排：free 按长短排好（插入排序：短的先、一样长按编号）先放在 stack 里，从前往后扫、拿掉的依次写到前面（写的位置不超过读的位置）
    const out = (outBuf = room(outBuf, n));
    out.fill(0, 0, n);
    const stack = (stackBuf = room(stackBuf, n));
    for (let p = 0; p < nf; p++) {
      const i = free[p];
      let q = p;
      while (q > 0) {
        const h = stack[q - 1];
        if (len[h] < len[i] || (len[h] === len[i] && h < i)) break;
        stack[q] = h;
        q--;
      }
      stack[q] = i;
    }
    let sp = 0;
    for (let p = 0; p < nf; p++) {
      const i = stack[p];
      if (clash(i, level[i]) > 0) {
        out[i] = 1;
        level[i] = 0;
        stack[sp++] = i;
      }
    }
    while (sp) {
      const i = stack[--sp];
      for (let t = bOff[i], e = bOff[i + 1]; t < e; t++) {
        const k = bAdj[t];
        if (!dead[k] && level[k] && !out[k]) {
          out[k] = 1;
          level[k] = 0;
          stack[sp++] = k; // 每段最多进一次（进之前先标 out），stack 长 n 够用
        }
      }
    }
    for (let q = 0; q < no; q++) {
      const i = order[q];
      if (!out[i]) continue;
      let L = 1;
      for (let t = aOff[i]; t < aOff[i + 1]; t++) { const j = aAdj[t]; if (!dead[j] && level[j] >= L) L = level[j] + 1; }
      while (L <= top && !ok(i, L)) L++;
      if (L > top) dead[i] = 1;
      else level[i] = L;
    }
  };
  /** 段 i 放在第 L 层是否满足所有约束（别的段按当前的层） */
  const ok = (i, L) => {
    for (let t = aOff[i], e = aOff[i + 1]; t < e; t++) { const j = aAdj[t]; if (!dead[j] && level[j] && L <= level[j]) return false; }
    for (let t = bOff[i], e = bOff[i + 1]; t < e; t++) { const k = bAdj[t]; if (!dead[k] && level[k] && L >= level[k]) return false; }
    for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) { const m = nAdj[t]; if (!dead[m] && level[m] === L) return false; }
    return fixedOk(i, L);
  };
  for (let q = 0; q < no; q++) {
    const i = order[q];
    let L = 1;
    for (let t = aOff[i]; t < aOff[i + 1]; t++) { const j = aAdj[t]; if (!dead[j] && level[j] >= L) L = level[j] + 1; }
    while (L <= top && !ok(i, L)) L++;
    if (L > top) dead[i] = 1;
    else level[i] = L;
  }
  // 局部搜索之前问一次退火要不要拒（route.js 的 elevAsk，经 elevation.js 的 liftLegs 传进来）：到这里判死的段（自己走回头路、两叠同格、
  // 成环里最短的、贪心放不下的）后面只会更多、不会再放回去，最后各记一条「无处可放」。回调说注定被拒就不往下算（返回 null）；
  // 回调只读，不拒时照常算完（fit 的随机数每次调用按段数现开，跳过它不影响别的评估）
  if (onGreedy) {
    let nd = 0;
    for (let i = 0; i < n; i++) if (dead[i]) nd++;
    if (onGreedy(hookCtx, nd)) return null;
  }
  let over = false;
  for (let q = 0; q < no; q++) {
    if (level[order[q]] > maxLevel) {
      over = true;
      break;
    }
  }
  if (over) {
    const ids = (idsBuf = room(idsBuf, no));
    let nids = 0;
    for (let q = 0; q < no; q++) if (!dead[order[q]]) ids[nids++] = order[q];
    fit(ids, nids);
  }
  // 改进：落低、长短换层。每次改动都让「格子数 × 层」的某种凸代价下降，不会循环；轮数也设了上限。
  // live[0..nl)：没断开的段，长的先、一样长按编号（插入排序）
  const live = (liveBuf = room(liveBuf, no));
  let nl = 0;
  for (let q = 0; q < no; q++) {
    const i = order[q];
    if (dead[i]) continue;
    let p = nl++;
    while (p > 0) {
      const h = live[p - 1];
      if (len[h] > len[i] || (len[h] === len[i] && h < i)) break;
      live[p] = h;
      p--;
    }
    live[p] = i;
  }
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (let q = 0; q < nl; q++) {
      const i = live[q];
      const cur = level[i];
      level[i] = 0;
      let L = 1;
      while (L < cur && !ok(i, L)) L++;
      level[i] = L;
      if (L < cur) changed = true;
    }
    for (let q = 0; q < nl; q++) {
      const i = live[q];
      const a = level[i];
      // 碰到第一个能换的就停（neq 的行按加的先后走）
      for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) {
        const m = nAdj[t];
        if (dead[m]) continue;
        const b = level[m];
        if (b >= a || len[m] >= len[i]) continue;
        level[i] = 0;
        level[m] = 0;
        let swap = false;
        if (ok(m, a)) {
          level[m] = a;
          if (ok(i, b)) swap = true;
        }
        level[i] = swap ? b : a;
        level[m] = swap ? a : b;
        if (swap) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  const res = [];
  for (let i = 0; i < n; i++) res.push(dead[i] ? 0 : level[i]);
  return res;
}

/** fit 的随机数（mulberry32）：seed 已经加过这一步的增量，返回 [0, 1) */
function unitOf(s) {
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * fit 的最小冲突局部搜索：最多 maxIt 步，每步在有冲突的段里按 free 的顺序随机挑第 k 个（位表 words：free 里第 p 位的段有冲突，
 * wcnt 是每个字里的位数），挪到 1..maxLevel 里冲突最少的层（离开的那层 3 步之内不回去，一样少的随机挑）。
 * 每段的冲突数 cl 和总数 tot 增量维护：挪一段只改它自己和它的邻居（冲突是两两对称的：above / below 互为反向，neq 两边都加，
 * 段 m 的冲突只和邻居的层有关）。冲突最少的那次分配抄在 best 里，最后抄回 level；返回它的冲突数。
 * 写成模块级函数、不建闭包：tot、nBad、seed 都是局部变量，循环里不用读写闭包的上下文。
 * bits 为真（段数不超过 32）时挪段只碰冲突数真的变了的邻居：按位从 mA / mB / mN（每段 above / below / neq 里没断开的邻居）、
 * fm（free 里的段）、lvl（每层有哪些段）里找出来；一个邻居在几张表里时每张表各改一次，和逐张表走一样
 */
function fitSearch(n, maxIt, seed, tot, nBad, free, dOff, dLen, dBuf, level, dead, isFree, pos, cl, words, wcnt, aOff, aAdj, bOff, bAdj, nOff, nAdj, maxLevel, per, tabu, pick, best, bits, mA, mB, mN, fm, lvl) {
  const stride = maxLevel + 1;
  per[0] = 0;
  let bestC = tot;
  for (let it = 0; bestC > 0 && it < maxIt; it++) {
    if (!nBad) break;
    // 有冲突的段里按 free 的顺序挑第 k 个（0 起）：先数到它在哪个字，再在字里去掉低的 k 位
    seed = (seed + 0x6d2b79f5) >>> 0;
    let k = Math.floor(unitOf(seed) * nBad);
    let w = 0;
    while (k >= wcnt[w]) {
      k -= wcnt[w];
      w++;
    }
    let x = words[w];
    for (; k > 0; k--) x &= x - 1;
    const i = free[(w << 5) + (31 - Math.clz32(x & -x))];
    const cur = level[i];
    // 段 i 在 1..maxLevel 每一层的冲突数（差分数组，per[0] 一直是 0），和对每层各调一次 clash 一样
    for (let L = 1; L <= stride; L++) per[L] = 0;
    for (let t = aOff[i], e = aOff[i + 1]; t < e; t++) {
      const j = aAdj[t];
      if (dead[j]) continue;
      const u = Math.min(level[j], maxLevel);
      if (u >= 1) {
        per[1]++;
        per[u + 1]--;
      }
    } // L <= level[j]
    for (let t = bOff[i], e = bOff[i + 1]; t < e; t++) {
      const k2 = bAdj[t];
      if (dead[k2]) continue;
      const lo = Math.max(level[k2], 1);
      if (lo <= maxLevel) {
        per[lo]++;
        per[stride]--;
      }
    } // L >= level[k]
    for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) {
      const m = nAdj[t];
      if (dead[m]) continue;
      const L = level[m];
      if (L >= 1 && L <= maxLevel) {
        per[L]++;
        per[L + 1]--;
      }
    }
    for (let L = 1; L <= maxLevel; L++) per[L] += per[L - 1];
    const ti = i * stride;
    let np = 0;
    let pc = 0x7fffffff;
    for (let t = dOff[i], e = t + dLen[i]; t < e; t++) {
      const L = dBuf[t];
      if (L === cur || tabu[ti + L] > it) continue;
      const c = per[L];
      if (c < pc) {
        pc = c;
        pick[0] = L;
        np = 1;
      } else if (c === pc) pick[np++] = L;
    }
    if (!np) continue;
    tabu[ti + cur] = it + 3;
    seed = (seed + 0x6d2b79f5) >>> 0;
    const to = pick[Math.floor(unitOf(seed) * np)];
    // 段 i 从 cur 层挪到 to 层（挑中的几层冲突数都是 pc）：自己的换掉，每个邻居只改和 i 那一条关系；cl 由正变 0 或由 0 变正时翻位
    {
      const o = cl[i];
      if (o > 0 !== pc > 0) {
        const p = pos[i];
        words[p >> 5] ^= 1 << (p & 31);
        const d = pc > 0 ? 1 : -1;
        wcnt[p >> 5] += d;
        nBad += d;
      }
      tot += pc - o;
      cl[i] = pc;
    }
    if (bits) {
      // 会变的：neq 里在 to 层的 +1、在 cur 层的 −1；above 里层在 [cur, to) 的 −1（往上挪）或 [to, cur) 的 +1（往下挪）；
      // below 里层在 (cur, to] 的 +1 或 (to, cur] 的 −1
      let rA = 0;
      let rB = 0;
      const lo = cur < to ? cur : to;
      const hi = cur < to ? to : cur;
      for (let v = lo; v < hi; v++) rA |= lvl[v];
      for (let v = lo + 1; v <= hi; v++) rB |= lvl[v];
      const nm = mN[i] & fm;
      const dA = to > cur ? -1 : 1;
      for (let g = 0; g < 4; g++) {
        let m = g === 0 ? nm & lvl[to] : g === 1 ? nm & lvl[cur] : g === 2 ? mA[i] & fm & rA : mB[i] & fm & rB;
        const d = g === 0 ? 1 : g === 1 ? -1 : g === 2 ? dA : -dA;
        while (m !== 0) {
          const b = m & -m;
          m ^= b;
          const j = 31 - Math.clz32(b);
          const o = cl[j];
          const v = o + d;
          cl[j] = v;
          tot += d;
          if (o > 0 !== v > 0) {
            const p = pos[j];
            words[p >> 5] ^= 1 << (p & 31);
            wcnt[p >> 5] += d;
            nBad += d;
          }
        }
      }
      lvl[cur] &= ~(1 << i);
      lvl[to] |= 1 << i;
      level[i] = to;
      if (tot < bestC) {
        for (let j = 0; j < n; j++) best[j] = level[j];
        bestC = tot;
      }
      continue;
    }
    for (let t = aOff[i], e = aOff[i + 1]; t < e; t++) {
      const j = aAdj[t];
      if (!isFree[j]) continue;
      const lj = level[j];
      const now = lj >= to;
      if (lj >= cur === now) continue; // j 必须比 i 低：j 的冲突里数的是 level[j] >= level[i]
      const d = now ? 1 : -1;
      const o = cl[j];
      cl[j] = o + d;
      tot += d;
      if (o > 0 !== o + d > 0) {
        const p = pos[j];
        words[p >> 5] ^= 1 << (p & 31);
        wcnt[p >> 5] += d;
        nBad += d;
      }
    }
    for (let t = bOff[i], e = bOff[i + 1]; t < e; t++) {
      const k2 = bAdj[t];
      if (!isFree[k2]) continue;
      const lk = level[k2];
      const now = lk <= to;
      if (lk <= cur === now) continue; // k 必须比 i 高：k 的冲突里数的是 level[k] <= level[i]
      const d = now ? 1 : -1;
      const o = cl[k2];
      cl[k2] = o + d;
      tot += d;
      if (o > 0 !== o + d > 0) {
        const p = pos[k2];
        words[p >> 5] ^= 1 << (p & 31);
        wcnt[p >> 5] += d;
        nBad += d;
      }
    }
    for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) {
      const m = nAdj[t];
      if (!isFree[m]) continue;
      const lm = level[m];
      const now = lm === to;
      if (lm === cur === now) continue;
      const d = now ? 1 : -1;
      const o = cl[m];
      cl[m] = o + d;
      tot += d;
      if (o > 0 !== o + d > 0) {
        const p = pos[m];
        words[p >> 5] ^= 1 << (p & 31);
        wcnt[p >> 5] += d;
        nBad += d;
      }
    }
    level[i] = to;
    if (tot < bestC) {
      for (let j = 0; j < n; j++) best[j] = level[j];
      bestC = tot;
    }
  }
  for (let j = 0; j < n; j++) level[j] = best[j];
  return bestC;
}
