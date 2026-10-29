// 高架段分层：在两两约束下给每段挑一层，长的段尽量低、短的段去高层（层数分布像金字塔：2 层够多了才有 3 层，3 层够多了才有 4 层）。
//
// 约束来自每段占的平面格子（升降那一叠占 1..L 层，RAMP_MAX_DZ = 0）：
// - 两段的水平部分经过同一格：不能同层（neq）；
// - 我的水平部分从你升降那一叠上空经过：我必须比你高（above）；
// - 两叠升降在同一格、或者互相都压在对方的叠上：怎么都放不下，短的那段算断开。
//
// 做法：按「必须比别人低的先排」的拓扑序，同等条件下长的先排，每段放到满足约束的最低层；
// 再反复做两种改进直到没有变化：能往下落就落；和一段比自己短、在自己下面、只是因为同格不能同层的段换层（长的往下）。
// 不再「放不下就把挡路的请出去重排」，所以不会来回打转。
//
// 约束表一律按 CSR 用：第 i 行是 adj[off[i] .. off[i + 1])，off[0] = 0，行内的先后就是原来 Set 的插入顺序、不重复。
// 原来每段一个 Set（below 也是现建的 Set），每次遍历都走 Set 的迭代器、每次调用建 n 个 Set；fit 里还按次建 dom 的 Map、每次改进 slice 一份 best。
// 现在表是整数数组，下面这些临时表按线程复用（每个 worker 一份模块；solveLevels 不会重入，回调 fixedOk 不会再调它），不够大才换大的。
// 所有循环照原来的先后走同样的元素，rand() 的次数和先后不变，结果逐字一样。

/** 按线程复用的缓冲区：a 够 size 长就原样用，不够换一个更大的同类型的（旧内容不要：用的人先写后读，或者自己清零） */
const room = (a, size) => (a.length >= size ? a : new a.constructor(Math.max(size, Math.ceil(a.length * 1.5))));
let belowOff = new Int32Array(0);
let belowAdj = new Int32Array(0);
let deadBuf = new Uint8Array(0);
let indegBuf = new Int32Array(0);
let doneBuf = new Uint8Array(0);
// fit 用的
let domOff = new Int32Array(0);
let domLen = new Int32Array(0);
let domBuf = new Int32Array(0);
let freeBuf = new Int32Array(0);
let isFreeBuf = new Uint8Array(0);
let posBuf = new Int32Array(0);
let clBuf = new Int32Array(0);
let fenBuf = new Int32Array(0);
let perBuf = new Int32Array(0);
let tabuBuf = new Int32Array(0);
let pickBuf = new Int32Array(0);
let bestBuf = new Int32Array(0);
let outBuf = new Uint8Array(0);
let stackBuf = new Int32Array(0);
let rowMark = new Int32Array(0); // toCsr 去重用：值 j 在这一行出现过就记这一行的戳
let rowStamp = 0;

/**
 * 按先后记下的 m 条边 E（第 t 条：行 E[2t]、值 E[2t + 1]，都在 0..n−1）排成 n 行的 CSR，写进 off（至少 n + 1 长）、adj（至少 m 长）。
 * 同一行按记下的先后放（计数排序是稳定的），重复的值只留第一次——和按同样的先后往每行的 Set 里 add 一模一样
 * （已有的再 add 不变，先后也不变）。elevation.js 两两加约束时用它代替每段一个 Set
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
 * @param {number[]|null} [o.minLevel] 每段最低第几层（桥段从熔炉、制造台头顶过，至少第 4 层；见 route.js 的 bridges）；null 时都从第 1 层起
 * @param {number[]|null} [o.maxLevels] 每段不罚的最高层（代替 maxLevel，和 minLevel 一起给）；null 时都按 maxLevel
 * @returns {number[]} 每段的层，0 表示断开
 */
export function solveLevels(n, { len, neq, above, bad, fixedOk, maxLevel, top, minLevel = null, maxLevels = null, onGreedy = null, hookCtx = null }) {
  // 每段最低层、不罚的最高层（都没给时和原来一样：1 和 maxLevel）；fit 的层号表按各段里最高的那个开
  const lowOf = (i) => (minLevel ? minLevel[i] : 1);
  const capOf = (i) => (maxLevels ? maxLevels[i] : maxLevel);
  let capAll = maxLevel;
  if (maxLevels) for (let i = 0; i < n; i++) capAll = Math.max(capAll, maxLevels[i]);
  const level = new Array(n).fill(0);
  const N = csrOf(n, neq);
  const A = csrOf(n, above);
  const nOff = N.off;
  const nAdj = N.adj;
  const aOff = A.off;
  const aAdj = A.adj;
  const dead = (deadBuf = room(deadBuf, n)); // 原来是 bad.slice()：断开记 1，只按真假读
  for (let i = 0; i < n; i++) dead[i] = bad[i] ? 1 : 0;
  // below[j]：必须比 j 高的段。原来是「i 从小到大、for j of above[i]: below[j].add(i)」，above 的行不重复，所以 below 每行按 i 递增、不重复；
  // 这里按同样的 i 递增做计数排序放进去，每行的先后和原来的 Set 一样
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
  // 拓扑序：必须比别人低的先排；能排的里面长的先排（一样长的按编号）
  const indeg = (indegBuf = room(indegBuf, n));
  indeg.fill(0, 0, n);
  for (let i = 0; i < n; i++) if (!dead[i]) for (let t = aOff[i]; t < aOff[i + 1]; t++) if (!dead[aAdj[t]]) indeg[i]++;
  const done = (doneBuf = room(doneBuf, n));
  done.fill(0, 0, n);
  const order = [];
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
    order.push(pick);
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
   * 贪心排出来超过 maxLevel 时：在 1..maxLevel 层里找没有冲突的分配（最小冲突局部搜索：挑一段有冲突的，挪到冲突最少的那层，
   * 刚离开的那层几步之内不回去）；找不到就取冲突最少的那次，冲突的段先拿掉（短的先拿），再从低往高找空层放回去。
   */
  const fit = (ids) => {
    // 每段能挪的层：最低层到不罚的最高层（没给 minLevel / maxLevels 时就是 1..maxLevel）。
    // 原来是按段的 Map，值是 1..capAll 过滤出来的数组；现在按 ids 的顺序依次排在 domBuf 里，段 i 的是 domBuf[domOff[i] .. + domLen[i])，
    // 层从低到高。fixedOk 照原来的先后调（ids 的顺序、层从低到高，前两个条件不满足就不调）
    domOff = room(domOff, n);
    domLen = room(domLen, n);
    domBuf = room(domBuf, ids.length * capAll);
    const dOff = domOff;
    const dLen = domLen;
    const dBuf = domBuf;
    let dTop = 0;
    for (let q = 0; q < ids.length; q++) {
      const i = ids[q];
      dOff[i] = dTop;
      for (let L = 1; L <= capAll; L++) if (L >= lowOf(i) && L <= capOf(i) && fixedOk(i, L)) dBuf[dTop++] = L;
      dLen[i] = dTop - dOff[i];
    }
    // 4 层里都被固定的东西挡住的段只能升上去，不动它。free[0..nf) 按 ids 的顺序（原来的 ids.filter）
    const free = (freeBuf = room(freeBuf, ids.length));
    let nf = 0;
    for (let q = 0; q < ids.length; q++) if (dLen[ids[q]]) free[nf++] = ids[q];
    for (let p = 0; p < nf; p++) {
      const i = free[p];
      if (level[i] <= capOf(i)) continue;
      let b = 0;
      for (let t = dOff[i], e = t + dLen[i]; t < e; t++) { const L = dBuf[t]; if (!b || clash(i, L) < clash(i, b)) b = L; }
      level[i] = b;
    }
    let seed = (n * 2654435761) >>> 0;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // 每段当前的冲突数 cl[i] 和总数 tot 增量维护：挪一段只重算它和它的邻居（原来每步把所有段数两遍，引力矩阵上占 route() 三成时间）。
    // 冲突是两两对称的（above / below 互为反向，neq 两边都加），段 m 的冲突只和邻居的层有关；结果和每步全数一遍逐字一致
    const isFree = (isFreeBuf = room(isFreeBuf, n));
    isFree.fill(0, 0, n);
    for (let p = 0; p < nf; p++) isFree[free[p]] = 1;
    // 段 -> 它在 free 里的 1 起位置（只给 free 里的段写）。set 只会碰 free 里的段（见 set 处的核实），别的位置是上一次留下的也不会读到
    const posInFree = (posBuf = room(posBuf, n));
    for (let j = 0; j < nf; j++) posInFree[free[j]] = j + 1;
    const cl = (clBuf = room(clBuf, n));
    cl.fill(0, 0, n);
    let tot = 0;
    let nBad = 0; // 有冲突（cl > 0）的段数
    for (let p = 0; p < nf; p++) {
      const i = free[p];
      tot += cl[i] = clash(i, level[i]);
      if (cl[i] > 0) nBad++;
    }
    // 树状数组（Fenwick）按 free 顺序记每一位 cl>0 ? 1 : 0，用来 O(log n) 取「第 k 个有冲突的段」。
    // 原来每次迭代按 free 顺序线性扫到第 k 个 cl>0 的段是 O(n)（fit 自身占整轮 CPU 12.6%，大线不可行时几乎每次扫满），
    // 树上二分挑出来的段和那次线性扫完全是同一个（等价说明见下面取段处）。初始位按上面同样的 cl>0 判定建（1..nf 都先写一遍，不用清零）
    const fen = (fenBuf = room(fenBuf, nf + 1)); // 1 起下标
    for (let p = 1; p <= nf; p++) fen[p] = cl[free[p - 1]] > 0 ? 1 : 0;
    for (let p = 1; p <= nf; p++) { const up = p + (p & -p); if (up <= nf) fen[up] += fen[p]; } // O(n) 线性建树
    const fenAdd = (p, d) => { for (; p <= nf; p += p & -p) fen[p] += d; };
    let fenHi = 1; // ≤ nf 的最大 2 的幂，二分下降的起点
    while (fenHi << 1 <= nf) fenHi <<= 1;
    const set = (m, v) => {
      if (cl[m] > 0 !== v > 0) { nBad += v > 0 ? 1 : -1; fenAdd(posInFree[m], v > 0 ? 1 : -1); } // m 必来自 free（move 对邻居有 isFree 守卫，i 自己来自 free），posInFree[m] ≥ 1
      tot += v - cl[m];
      cl[m] = v;
    };
    /** 段 i 从 a 层挪到 b 层（它这次的冲突数已经算好是 ci）：自己的换掉，每个邻居只改和 i 那一条关系 */
    const move = (i, a, b, ci) => {
      set(i, ci);
      for (let t = aOff[i], e = aOff[i + 1]; t < e; t++) { const j = aAdj[t]; if (isFree[j]) { const was = level[j] >= a, now = level[j] >= b; if (was !== now) set(j, cl[j] + (now ? 1 : -1)); } } // j 必须比 i 低：j 的冲突里数的是 level[j] >= level[i]
      for (let t = bOff[i], e = bOff[i + 1]; t < e; t++) { const k = bAdj[t]; if (isFree[k]) { const was = level[k] <= a, now = level[k] <= b; if (was !== now) set(k, cl[k] + (now ? 1 : -1)); } } // k 必须比 i 高：k 的冲突里数的是 level[k] <= level[i]
      for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) { const m = nAdj[t]; if (isFree[m]) { const was = level[m] === a, now = level[m] === b; if (was !== now) set(m, cl[m] + (now ? 1 : -1)); } }
    };
    // 段 i 在 1..capAll 每一层的冲突数一次算出（差分数组）：和对每层各调一次 clash 结果一样（capAll 没给 maxLevels 时就是 maxLevel）
    const per = (perBuf = room(perBuf, capAll + 2));
    const clashAll = (i) => {
      per.fill(0, 0, capAll + 2);
      for (let t = aOff[i], e = aOff[i + 1]; t < e; t++) { const j = aAdj[t]; if (!dead[j]) { const u = Math.min(level[j], capAll); if (u >= 1) { per[1]++; per[u + 1]--; } } } // L <= level[j]
      for (let t = bOff[i], e = bOff[i + 1]; t < e; t++) { const k = bAdj[t]; if (!dead[k]) { const lo = Math.max(level[k], 1); if (lo <= capAll) { per[lo]++; per[capAll + 1]--; } } } // L >= level[k]
      for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) { const m = nAdj[t]; if (!dead[m]) { const L = level[m]; if (L >= 1 && L <= capAll) { per[L]++; per[L + 1]--; } } }
      for (let L = 1; L <= capAll; L++) per[L] += per[L - 1];
    };
    const stride = capAll + 1;
    const tabu = (tabuBuf = room(tabuBuf, n * stride)); // 段 i 离开第 L 层后，第几步之前不回去（0 = 没禁）
    tabu.fill(0, 0, n * stride);
    const pick = (pickBuf = room(pickBuf, capAll));
    // 冲突最少的那次分配：原来每次改进 slice 一份，现在抄进同一张表（值和抄的时机都一样）
    const best = (bestBuf = room(bestBuf, n));
    for (let i = 0; i < n; i++) best[i] = level[i];
    let bestC = tot;
    for (let it = 0; bestC > 0 && it < 100 + 30 * ids.length; it++) {
      if (!nBad) break;
      // 有冲突的段里按 free 的顺序挑第 k 个（和原来先过滤成数组再挑一样）
      const k = Math.floor(rand() * nBad); // rand() 的次数、顺序不变（仍然每次迭代先抽 k）
      // 树上二分：找最小的 pos 使 free[0..pos] 里 cl>0 的个数 = k+1，就是原来按 free 顺序线性扫到的第 k 个（0 起）有冲突的段，一字不差
      let pos = 0;
      let rem = k + 1;
      for (let pw = fenHi; pw > 0; pw >>= 1) { const nx = pos + pw; if (nx <= nf && fen[nx] < rem) { pos = nx; rem -= fen[nx]; } }
      const i = free[pos]; // 二分返回的 1 起位置是 pos+1，对应 free 的 0 起下标 pos
      const cur = level[i];
      clashAll(i);
      let np = 0;
      let pc = Infinity;
      for (let t = dOff[i], e = t + dLen[i]; t < e; t++) {
        const L = dBuf[t];
        if (L === cur || tabu[i * stride + L] > it) continue;
        const c = per[L];
        if (c < pc) {
          pc = c;
          pick[0] = L;
          np = 1;
        } else if (c === pc) pick[np++] = L;
      }
      if (!np) continue;
      tabu[i * stride + cur] = it + 3;
      const to = pick[Math.floor(rand() * np)];
      move(i, cur, to, pc); // 挑中的几层冲突数都是 pc
      level[i] = to;
      if (tot < bestC) {
        for (let j = 0; j < n; j++) best[j] = level[j];
        bestC = tot;
      }
    }
    for (let i = 0; i < n; i++) level[i] = best[i];
    if (!bestC) return;
    // 拿掉的段连同必须比它高的段（一路往上）一起拿掉，再按拓扑序放回去：放回去时上面没有压着的段，总能往上找到层。
    // 原来 out 是 Set、stack = [...out]：现在 out 记成标记，stack 就是按拿掉的先后排的数组。free 按长短排好的那份也先放在 stack 里，
    // 从前往后扫、拿掉的依次写到前面（写的位置不超过读的位置），扫完前 sp 个正好是原来 [...out] 的顺序
    const out = (outBuf = room(outBuf, n));
    out.fill(0, 0, n);
    const stack = (stackBuf = room(stackBuf, n));
    for (let p = 0; p < nf; p++) stack[p] = free[p];
    stack.subarray(0, nf).sort((a, b) => len[a] - len[b] || a - b); // 短的先、一样长按编号：全序，排出来和原来 free.slice().sort 一样
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
    for (const i of order) {
      if (!out[i]) continue;
      let L = lowOf(i);
      for (let t = aOff[i]; t < aOff[i + 1]; t++) { const j = aAdj[t]; if (!dead[j] && level[j] >= L) L = level[j] + 1; }
      while (L <= top && !ok(i, L)) L++;
      if (L > top) dead[i] = 1;
      else level[i] = L;
    }
  };
  /** 段 i 放在第 L 层是否满足所有约束（别的段按当前的层）；低于这段的最低层也不行 */
  const ok = (i, L) => {
    if (minLevel && L < minLevel[i]) return false;
    for (let t = aOff[i], e = aOff[i + 1]; t < e; t++) { const j = aAdj[t]; if (!dead[j] && level[j] && L <= level[j]) return false; }
    for (let t = bOff[i], e = bOff[i + 1]; t < e; t++) { const k = bAdj[t]; if (!dead[k] && level[k] && L >= level[k]) return false; }
    for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) { const m = nAdj[t]; if (!dead[m] && level[m] === L) return false; }
    return fixedOk(i, L);
  };
  for (const i of order) {
    let L = lowOf(i);
    for (let t = aOff[i]; t < aOff[i + 1]; t++) { const j = aAdj[t]; if (!dead[j] && level[j] >= L) L = level[j] + 1; }
    while (L <= top && !ok(i, L)) L++;
    if (L > top) dead[i] = 1;
    else level[i] = L;
  }
  // 局部搜索之前问一次（elevation.js 的 liftLegs 传的，route.js 退火提前拒绝的第六处）：到这里判死的段（自己走回头路、两叠同格、
  // 成环里最短的、贪心放不下的）后面只会更多、不会再放回去，最后各记一条「无处可放」。回调说注定被拒就不往下算（返回 null）；
  // 回调只读，不拒时照常算完，结果一字不差（fit 的随机数每次调用按段数现开，跳过它不影响别的评估）
  if (onGreedy) {
    let nd = 0;
    for (let i = 0; i < n; i++) if (dead[i]) nd++;
    if (onGreedy(hookCtx, nd)) return null;
  }
  if (order.some((i) => level[i] > capOf(i))) fit(order.filter((i) => !dead[i]));
  // 改进：落低、长短换层。每次改动都让「格子数 × 层」的某种凸代价下降，不会循环；轮数也设了上限
  const live = order.filter((i) => !dead[i]).sort((a, b) => len[b] - len[a] || a - b);
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const i of live) {
      const cur = level[i];
      level[i] = 0;
      let L = 1;
      while (L < cur && !ok(i, L)) L++;
      level[i] = L;
      if (L < cur) changed = true;
    }
    for (const i of live) {
      const a = level[i];
      // 碰到第一个能换的就停：neq 的行按原来 Set 的插入顺序走，换的是同一段
      for (let t = nOff[i], e = nOff[i + 1]; t < e; t++) {
        const m = nAdj[t];
        if (dead[m]) continue;
        const b = level[m];
        if (b >= a || len[m] >= len[i]) continue;
        level[i] = 0;
        level[m] = 0;
        let fit = false;
        if (ok(m, a)) {
          level[m] = a;
          if (ok(i, b)) fit = true;
        }
        level[i] = fit ? b : a;
        level[m] = fit ? a : b;
        if (fit) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  for (let i = 0; i < n; i++) if (dead[i]) level[i] = 0;
  return level;
}
