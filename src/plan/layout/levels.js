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

/**
 * @param {number} n 段数
 * @param {object} o
 * @param {number[]} o.len 每段的格子数（权重）
 * @param {Set<number>[]} o.neq 不能同层的段
 * @param {Set<number>[]} o.above above[i] 里的段 i 都必须比它们高
 * @param {boolean[]} o.bad 怎么都放不下的段（自己走回头路、被物流站挡死……）
 * @param {(i: number, L: number) => boolean} o.fixedOk 第 L 层和已经固定的东西（物流站、形状随层变的段）不冲突
 * @param {number} o.maxLevel 不罚的最高层：贪心排出来超过它时先在这几层里找没有冲突的分配
 * @param {number} o.top 最高试到第几层（再高就算断开）
 * @returns {number[]} 每段的层，0 表示断开
 */
export function solveLevels(n, { len, neq, above, bad, fixedOk, maxLevel, top }) {
  const level = new Array(n).fill(0);
  const dead = bad.slice();
  const below = Array.from({ length: n }, () => new Set()); // below[j]：必须比 j 高的段
  for (let i = 0; i < n; i++) for (const j of above[i]) below[j].add(i);
  // 拓扑序：必须比别人低的先排；能排的里面长的先排（一样长的按编号）
  const indeg = new Array(n).fill(0);
  for (let i = 0; i < n; i++) if (!dead[i]) for (const j of above[i]) if (!dead[j]) indeg[i]++;
  const done = new Array(n).fill(false);
  const order = [];
  for (let left = dead.filter((d) => !d).length; left > 0; ) {
    let pick = -1;
    for (let i = 0; i < n; i++) if (!dead[i] && !done[i] && indeg[i] === 0 && (pick < 0 || len[i] > len[pick])) pick = i;
    if (pick < 0) {
      // 成环：剩下的里面断开最短的
      let s = -1;
      for (let i = 0; i < n; i++) if (!dead[i] && !done[i] && (s < 0 || len[i] < len[s])) s = i;
      dead[s] = true;
      left--;
      for (const k of below[s]) if (!dead[k] && !done[k]) indeg[k]--;
      continue;
    }
    done[pick] = true;
    order.push(pick);
    left--;
    for (const k of below[pick]) if (!dead[k] && !done[k]) indeg[k]--;
  }
  /** 段 i 放在第 L 层和别的段有几处冲突（不算固定的东西） */
  const clash = (i, L) => {
    let c = 0;
    for (const j of above[i]) if (!dead[j] && L <= level[j]) c++;
    for (const k of below[i]) if (!dead[k] && L >= level[k]) c++;
    for (const m of neq[i]) if (!dead[m] && level[m] === L) c++;
    return c;
  };
  /**
   * 贪心排出来超过 maxLevel 时：在 1..maxLevel 层里找没有冲突的分配（最小冲突局部搜索：挑一段有冲突的，挪到冲突最少的那层，
   * 刚离开的那层几步之内不回去）；找不到就取冲突最少的那次，冲突的段先拿掉（短的先拿），再从低往高找空层放回去。
   */
  const fit = (ids) => {
    const dom = new Map(ids.map((i) => [i, Array.from({ length: maxLevel }, (_, k) => k + 1).filter((L) => fixedOk(i, L))]));
    const free = ids.filter((i) => dom.get(i).length); // 4 层里都被固定的东西挡住的段只能升上去，不动它
    for (const i of free) {
      if (level[i] <= maxLevel) continue;
      let b = 0;
      for (const L of dom.get(i)) if (!b || clash(i, L) < clash(i, b)) b = L;
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
    const isFree = new Uint8Array(n);
    for (const i of free) isFree[i] = 1;
    const cl = new Int32Array(n);
    let tot = 0;
    let nBad = 0; // 有冲突（cl > 0）的段数
    for (const i of free) {
      tot += cl[i] = clash(i, level[i]);
      if (cl[i] > 0) nBad++;
    }
    const set = (m, v) => {
      if (cl[m] > 0 !== v > 0) nBad += v > 0 ? 1 : -1;
      tot += v - cl[m];
      cl[m] = v;
    };
    /** 段 i 从 a 层挪到 b 层（它这次的冲突数已经算好是 ci）：自己的换掉，每个邻居只改和 i 那一条关系 */
    const move = (i, a, b, ci) => {
      set(i, ci);
      for (const j of above[i]) if (isFree[j]) { const was = level[j] >= a, now = level[j] >= b; if (was !== now) set(j, cl[j] + (now ? 1 : -1)); } // j 必须比 i 低：j 的冲突里数的是 level[j] >= level[i]
      for (const k of below[i]) if (isFree[k]) { const was = level[k] <= a, now = level[k] <= b; if (was !== now) set(k, cl[k] + (now ? 1 : -1)); } // k 必须比 i 高：k 的冲突里数的是 level[k] <= level[i]
      for (const m of neq[i]) if (isFree[m]) { const was = level[m] === a, now = level[m] === b; if (was !== now) set(m, cl[m] + (now ? 1 : -1)); }
    };
    // 段 i 在 1..maxLevel 每一层的冲突数一次算出（差分数组）：和对每层各调一次 clash 结果一样
    const per = new Int32Array(maxLevel + 2);
    const clashAll = (i) => {
      per.fill(0);
      for (const j of above[i]) if (!dead[j]) { const u = Math.min(level[j], maxLevel); if (u >= 1) { per[1]++; per[u + 1]--; } } // L <= level[j]
      for (const k of below[i]) if (!dead[k]) { const lo = Math.max(level[k], 1); if (lo <= maxLevel) { per[lo]++; per[maxLevel + 1]--; } } // L >= level[k]
      for (const m of neq[i]) if (!dead[m]) { const L = level[m]; if (L >= 1 && L <= maxLevel) { per[L]++; per[L + 1]--; } }
      for (let L = 1; L <= maxLevel; L++) per[L] += per[L - 1];
    };
    const stride = maxLevel + 1;
    const tabu = new Int32Array(n * stride); // 段 i 离开第 L 层后，第几步之前不回去（0 = 没禁）
    const pickBuf = new Int32Array(maxLevel);
    let best = level.slice();
    let bestC = tot;
    for (let it = 0; bestC > 0 && it < 100 + 30 * ids.length; it++) {
      if (!nBad) break;
      // 有冲突的段里按 free 的顺序挑第 k 个（和原来先过滤成数组再挑一样）
      let k = Math.floor(rand() * nBad);
      let i = -1;
      for (const x of free) if (cl[x] > 0 && k-- === 0) { i = x; break; }
      const cur = level[i];
      clashAll(i);
      let np = 0;
      let pc = Infinity;
      for (const L of dom.get(i)) {
        if (L === cur || tabu[i * stride + L] > it) continue;
        const c = per[L];
        if (c < pc) {
          pc = c;
          pickBuf[0] = L;
          np = 1;
        } else if (c === pc) pickBuf[np++] = L;
      }
      if (!np) continue;
      tabu[i * stride + cur] = it + 3;
      const to = pickBuf[Math.floor(rand() * np)];
      move(i, cur, to, pc); // 挑中的几层冲突数都是 pc
      level[i] = to;
      if (tot < bestC) [best, bestC] = [level.slice(), tot];
    }
    for (let i = 0; i < n; i++) level[i] = best[i];
    if (!bestC) return;
    // 拿掉的段连同必须比它高的段（一路往上）一起拿掉，再按拓扑序放回去：放回去时上面没有压着的段，总能往上找到层
    const out = new Set();
    for (const i of free.slice().sort((a, b) => len[a] - len[b] || a - b))
      if (clash(i, level[i]) > 0) {
        out.add(i);
        level[i] = 0;
      }
    const stack = [...out];
    while (stack.length) {
      const i = stack.pop();
      for (const k of below[i])
        if (!dead[k] && level[k] && !out.has(k)) {
          out.add(k);
          level[k] = 0;
          stack.push(k);
        }
    }
    for (const i of order) {
      if (!out.has(i)) continue;
      let L = 1;
      for (const j of above[i]) if (!dead[j] && level[j] >= L) L = level[j] + 1;
      while (L <= top && !ok(i, L)) L++;
      if (L > top) dead[i] = true;
      else level[i] = L;
    }
  };
  /** 段 i 放在第 L 层是否满足所有约束（别的段按当前的层） */
  const ok = (i, L) => {
    for (const j of above[i]) if (!dead[j] && level[j] && L <= level[j]) return false;
    for (const k of below[i]) if (!dead[k] && level[k] && L >= level[k]) return false;
    for (const m of neq[i]) if (!dead[m] && level[m] === L) return false;
    return fixedOk(i, L);
  };
  for (const i of order) {
    let L = 1;
    for (const j of above[i]) if (!dead[j] && level[j] >= L) L = level[j] + 1;
    while (L <= top && !ok(i, L)) L++;
    if (L > top) dead[i] = true;
    else level[i] = L;
  }
  if (order.some((i) => level[i] > maxLevel)) fit(order.filter((i) => !dead[i]));
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
      for (const m of neq[i]) {
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
