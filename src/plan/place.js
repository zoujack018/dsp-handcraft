// 摆放搜索：决定配方组怎么拆块、每块放第几行、行内排第几、左边空几列。用模拟退火，成本由 route() 给出。
// - 拆块：大组（比如 11 台电动机）可以拆成几块放进不同的行，最宽那一行就不会把整张图撑宽，消灭中空行。
// - 空列（pad）：同一通道里上下两侧的分拣器同列时轨道必须错开，排不开时让两行错开几列。
// - 初始解：除了按层一行一组，还按若干目标宽度「折行」排布（像排版一样，一行放满就把组拆开换行），
//   让搜索从各种行数/宽度出发，自己权衡「多一行、少很多列」。
import { route, STATION_COLS } from './route.js';
import { layers } from './graph.js';

const mulberry = (a) => {
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** 可复现的伪随机数（mulberry32）。rand.peek() 看下一个数是多少，不往前走 */
export function rng(seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    return mulberry(a);
  };
  rand.peek = () => mulberry((a + 0x6d2b79f5) >>> 0);
  return rand;
}

const clone = (rows) => rows.map((r) => r.slice());
const compact = (rows) => rows.filter((r) => r.length);
/** 一个组最多拆成几块：块越多，物品带要经过的通道越多。限宽时大组放不进一行，按宽度放开 */
const maxBlocks = (graph, gid, usable) => {
  const g = graph.byId.get(gid);
  return usable ? Math.max(3, Math.ceil(g.width / usable) + 1) : 3;
};

const wholeBlocks = (graph) => Object.fromEntries(graph.groups.map((g) => [g.id, { gid: g.id, n: g.count }]));

/** 初始解：按最长路径分层，一层一行，整组不拆 */
export function layeredRows(graph) {
  const L = layers(graph);
  const rows = [];
  for (const g of graph.groups) {
    const l = L.get(g.id);
    (rows[l] ||= []).push(g.id);
  }
  return compact(rows);
}

/**
 * 初始解：按目标宽度折行。组按生产层级从原料往成品排，一行放满就换行，
 * 放不下的组拆成两块；奇数行倒序（蛇形），让换行处的上下游在竖直方向相邻。
 */
export function wrapRows(graph, width) {
  const L = layers(graph);
  const groups = graph.groups.slice().sort((a, b) => L.get(a.id) - L.get(b.id));
  const rows = [[]];
  const blocks = {};
  let w = 0;
  for (const g of groups) {
    let left = g.count;
    let part = 0;
    while (left > 0) {
      const room = Math.max(w === 0 ? 1 : 0, Math.floor((width - w - g.trailing) / g.pitch)); // 空行至少放一台，防止死循环
      // 行尾只剩一台的空间、而组还剩不少时，宁可换行，避免切出一台的小块
      if (room <= 0 || (room === 1 && left > 2 && w > 0)) {
        rows.push([]);
        w = 0;
        continue;
      }
      const n = Math.min(room, left);
      const bid = part === 0 && n === g.count ? g.id : `${g.id}~w${part}`;
      blocks[bid] = { gid: g.id, n };
      rows[rows.length - 1].push(bid);
      w += n * g.pitch + g.trailing;
      left -= n;
      part++;
    }
  }
  rows.forEach((r, i) => {
    if (i % 2) r.reverse();
  });
  // 奇数行整体右移半个工厂（制造台 2 列、熔炉 1 列），上下两行的分拣器一开始就是交错的
  const pads = {};
  rows.forEach((r, i) => {
    if (i % 2 && r.length) pads[r[0]] = graph.byId.get(blocks[r[0]].gid).pitch === 4 ? 2 : 1;
  });
  return { rows: compact(rows), blocks, pads };
}

/** 一组候选初始解：按层排布 + 几种目标宽度的折行排布。usable 是限宽时一行里能放工厂的列数 */
export function initialStates(graph, usable = null) {
  const total = graph.groups.reduce((a, g) => a + g.width, 0);
  const widest = Math.max(...graph.groups.map((g) => g.pitch * 2 + g.trailing));
  const states = usable ? [] : [{ rows: layeredRows(graph), blocks: wholeBlocks(graph), pads: {} }];
  const seen = new Set();
  const r0 = usable ? Math.ceil(total / usable) : 1;
  for (let r = r0; r <= r0 + 7; r++) {
    for (const slack of [0, 4]) {
      let w = Math.max(widest, Math.ceil(total / r) + slack);
      if (usable) w = Math.min(w, usable);
      if (seen.has(w)) continue;
      seen.add(w);
      states.push(wrapRows(graph, w));
    }
  }
  return states;
}

/** 每个块最多空出的列数：错开一个工厂间距以内就够了 */
const maxPad = (graph, st, bid) => Math.min(3, graph.byId.get(st.blocks[bid].gid).pitch - 1);

const blocksOfGroup = (st) => {
  const m = new Map();
  for (const [bid, b] of Object.entries(st.blocks)) {
    if (!m.has(b.gid)) m.set(b.gid, []);
    m.get(b.gid).push(bid);
  }
  return m;
};

/** 生产区最宽那一行的列数（不算辅路） */
const rowsWidth = (graph, st) =>
  Math.max(
    1,
    ...st.rows.map((r) =>
      r.reduce((a, bid) => {
        const g = graph.byId.get(st.blocks[bid].gid);
        return a + st.blocks[bid].n * g.pitch + g.trailing + (st.pads[bid] || 0);
      }, 0),
    ),
  );

function neighborStreets(graph, st, rand) {
  const cur = [...(st.streets || [])];
  const W = rowsWidth(graph, st);
  const v = rand();
  if (!cur.length || (v < 0.4 && cur.length < 4)) cur.push(2 + Math.floor(rand() * Math.max(1, W - 4)));
  else if (v < 0.7) cur.splice(Math.floor(rand() * cur.length), 1);
  else {
    const i = Math.floor(rand() * cur.length);
    cur[i] = Math.max(1, cur[i] + (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 4)));
  }
  return [...new Set(cur)].sort((a, b) => a - b);
}

/** 并行：挑两排，合起来不超过最宽的一排（限宽时不超过可用宽度）就并成一排；优先挑窄的排 */
function mergeRows(graph, st, rand, usable) {
  const widthOf = (row) => row.reduce((a, bid) => {
    const g = graph.byId.get(st.blocks[bid].gid);
    return a + st.blocks[bid].n * g.pitch + g.trailing + (st.pads[bid] || 0);
  }, 0);
  const ws = st.rows.map(widthOf);
  const cap = usable ?? Math.max(...ws);
  // 按宽度从窄到宽排，在最窄的几排里随机挑一排，再找一排能装下它的
  const order = ws.map((w, i) => ({ w, i })).sort((a, b) => a.w - b.w);
  const a = order[Math.floor(rand() * Math.min(order.length, 4))];
  const fits = order.filter((o) => o.i !== a.i && o.w + a.w <= cap);
  if (!fits.length) return null;
  const b = fits[Math.floor(rand() * fits.length)];
  const rows = clone(st.rows);
  const into = rows[b.i];
  const moved = rows[a.i];
  // 放在左边还是右边随机；相邻的两排并到靠下的那排位置
  rows[b.i] = rand() < 0.5 ? [...into, ...moved] : [...moved, ...into];
  rows.splice(a.i, 1);
  return { ...st, rows: compact(rows) };
}

const newId = (gid, rand) => `${gid}~${Math.floor(rand() * 2 ** 31).toString(36)}`;

function removeBlock(st, bid) {
  const rows = compact(st.rows.map((r) => r.filter((x) => x !== bid)));
  const blocks = { ...st.blocks };
  delete blocks[bid];
  const pads = { ...st.pads };
  delete pads[bid];
  return { ...st, rows, blocks, pads };
}

/**
 * hot：当前布局里和惩罚有关的块（route() 的 hot）。有惩罚时一半的动作挑它们下手，
 * 搜索就把力气花在出问题的地方，而不是在已经排好的块上随机游走。
 */
export function neighbor(graph, st, rand, usable = null, streets = false, hot = null) {
  let u = rand();
  const all = st.rows.flat();
  const hotIn = (list) => (hot?.length ? list.filter((b) => hot.includes(b)) : []);
  const pickFrom = (list) => {
    const h = hotIn(list);
    if (h.length && rand() < 0.5) return h[Math.floor(rand() * h.length)];
    return list[Math.floor(rand() * list.length)];
  };
  if (streets) {
    // 辅路：加一条、去一条或左右挪一挪（最多 4 条）
    if (u < 0.06) return { ...st, streets: neighborStreets(graph, st, rand) };
    u = (u - 0.06) / 0.94; // 其余的动作按原来的比例分
  }
  if (u < 0.05 && st.rows.length > 1) {
    // 并行：把一排整排并进另一排（合起来放得下时）。大产线里常有几排只放了一两组小配方，
    // 一块一块地挪每一步都会先把接线搅乱、被退火拒掉，整排一起并才跳得过去
    const merged = mergeRows(graph, st, rand, usable);
    if (merged) return merged;
  }
  u = (u - 0.05) / 0.95;
  if (u < 0.14) {
    // 改一个块左边的空列数
    const bid = pickFrom(all);
    const pads = { ...st.pads };
    const v = Math.floor(rand() * (maxPad(graph, st, bid) + 1));
    if (v) pads[bid] = v;
    else delete pads[bid];
    return { ...st, pads };
  }
  if (u < 0.26) {
    // 拆块：切下一部分，优先放到相邻行（两行夹着同一条通道，可以共用一条带）
    const byG = blocksOfGroup(st);
    const cand = all.filter((bid) => st.blocks[bid].n >= 2 && byG.get(st.blocks[bid].gid).length < maxBlocks(graph, st.blocks[bid].gid, usable));
    if (!cand.length) return { ...st, rows: neighborRows(st.rows, rand, hot) };
    const bid = pickFrom(cand);
    const b = st.blocks[bid];
    const k = 1 + Math.floor(rand() * (b.n - 1));
    const nid = newId(b.gid, rand);
    const blocks = { ...st.blocks, [bid]: { gid: b.gid, n: b.n - k }, [nid]: { gid: b.gid, n: k } };
    const rows = clone(st.rows);
    const ri = rows.findIndex((r) => r.includes(bid));
    if (rand() < 0.3) {
      rows[ri].splice(rows[ri].indexOf(bid) + (rand() < 0.5 ? 0 : 1), 0, nid);
    } else {
      const near = [ri - 1, ri + 1, ri - 1, ri + 1, Math.floor(rand() * (rows.length + 2)) - 1];
      const t = near[Math.floor(rand() * near.length)];
      if (t < 0) rows.unshift([nid]);
      else if (t >= rows.length) rows.push([nid]);
      else rows[t].splice(Math.floor(rand() * (rows[t].length + 1)), 0, nid);
    }
    return { ...st, rows: compact(rows), blocks };
  }
  if (u < 0.34) {
    // 合并同组的两块
    const multi = [...blocksOfGroup(st).values()].filter((l) => l.length >= 2);
    if (!multi.length) return { ...st, rows: neighborRows(st.rows, rand, hot) };
    const list = multi[Math.floor(rand() * multi.length)];
    const i = Math.floor(rand() * list.length);
    let j = Math.floor(rand() * (list.length - 1));
    if (j >= i) j++;
    const keepId = list[i];
    const gone = list[j];
    const next = removeBlock(st, gone);
    next.blocks[keepId] = { ...st.blocks[keepId], n: st.blocks[keepId].n + st.blocks[gone].n };
    return next;
  }
  if (u < 0.44) {
    // 同组两块之间挪一台
    const multi = [...blocksOfGroup(st).values()].filter((l) => l.length >= 2);
    if (!multi.length) return { ...st, rows: neighborRows(st.rows, rand, hot) };
    const list = multi[Math.floor(rand() * multi.length)];
    const from = list.filter((bid) => st.blocks[bid].n >= 2);
    if (!from.length) return { ...st, rows: neighborRows(st.rows, rand, hot) };
    const a = from[Math.floor(rand() * from.length)];
    const others = list.filter((x) => x !== a);
    const b = others[Math.floor(rand() * others.length)];
    const blocks = { ...st.blocks, [a]: { ...st.blocks[a], n: st.blocks[a].n - 1 }, [b]: { ...st.blocks[b], n: st.blocks[b].n + 1 } };
    return { ...st, blocks };
  }
  return { ...st, rows: neighborRows(st.rows, rand, hot) };
}

function neighborRows(rows, rand, hot = null) {
  const next = clone(rows);
  const all = next.flatMap((r, ri) => r.map((gid, gi) => [ri, gi]));
  const hotPos = hot?.length ? all.filter(([ri, gi]) => hot.includes(next[ri][gi])) : [];
  const pick = () => (hotPos.length && rand() < 0.5 ? hotPos[Math.floor(rand() * hotPos.length)] : all[Math.floor(rand() * all.length)]);
  const u = rand();
  if (u < 0.45) {
    // 把一个块挪到另一行（可能新开一行）的任意位置
    const [ri, gi] = pick();
    const [gid] = next[ri].splice(gi, 1);
    const k = Math.floor(rand() * (next.length + 1));
    if (rand() < 0.2 || k === next.length) next.splice(k, 0, [gid]);
    else next[k].splice(Math.floor(rand() * (next[k].length + 1)), 0, gid);
  } else if (u < 0.85) {
    // 交换任意两个块
    const [r1, g1] = pick();
    const [r2, g2] = pick();
    [next[r1][g1], next[r2][g2]] = [next[r2][g2], next[r1][g1]];
  } else if (u < 0.95) {
    // 整行镜像
    const ri = Math.floor(rand() * next.length);
    next[ri].reverse();
  } else {
    // 交换两行
    const a = Math.floor(rand() * next.length);
    const b = Math.floor(rand() * next.length);
    [next[a], next[b]] = [next[b], next[a]];
  }
  return compact(next);
}

/**
 * 参数的逐字键：JSON 分不开的值（undefined、NaN、±Infinity、−0）单独标出来，有函数时返回 null（不记）。
 * 键一样，参数对 route() 来说就一模一样（键的先后不同只会算成不一样，少记几次，不会记错）
 */
export function exactKey(value) {
  let ok = true;
  const key = JSON.stringify(value, (k, v) => {
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') ok = false;
    if (v === undefined) return '\u0000undefined';
    if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return `\u0000${Object.is(v, -0) ? '-0' : String(v)}`;
    return v;
  });
  return ok ? key : null;
}

// 初始解的评估记最近一份（同一张图、逐字一样的走线参数和初始排法）：没达标接着搜时换种子不换参数、多线程合并各轮时，
// 不用再把十几个初始解各算一遍。route() 是确定的，记下的结果和重算的一模一样；初始解和结果都只读，不会被改
let candsMemo = null;

/**
 * 搜索的准备：初始解各算一遍、按代价排好，以及几个闭包。完全确定，各个线程各算一遍结果一样。
 * snapshotMs / onSnapshot：实时预览的快照钩子（网页「观摩退火」用）。每隔约 snapshotMs 毫秒把当前状态
 * 报给 onSnapshot，钩子只读：不碰随机数、不多算 evalState、不改任何搜索状态，开不开结果逐字一致。
 */
function prepare(graph, { iterations = 5000, restarts = 4, seed = 7, routeOptions = {}, initial, candidateLimit = 12, snapshotMs = 0, onSnapshot = null } = {}) {
  const evalState = (st) => route(graph, st.rows, routeOptions, st.pads, st.blocks, st.streets || []);
  // 辅路（预留整列空地）默认不开：三个种子的对比里，小的物流站布局能省 1% 面积、少四成叠层，
  // 但大产线在同样的迭代数下面积多 4%~8%（多出来的邻域动作把搜索搅散了）。需要时 routeOptions.streets = true。
  const useStreets = routeOptions.streets === true;
  // 限宽时一行里能放工厂的列数：紧凑布局去掉左右边缘各 1 列；物流站靠左侧时去掉站列和走廊 8 列、右边缘 1 列
  const usable = routeOptions.maxWidth ? routeOptions.maxWidth - (routeOptions.station ? STATION_COLS + 1 : 2) : null;
  // 候选初始解先各算一遍，按成本排序，退火从最好的几个出发
  const key = exactKey([routeOptions, initial ?? null]);
  let cands;
  if (key !== null && candsMemo?.graph === graph && candsMemo.key === key) cands = candsMemo.cands;
  else {
    cands = (initial ? [{ rows: initial, blocks: wholeBlocks(graph), pads: {} }] : initialStates(graph, usable))
      .map((st) => ({ st, L: evalState(st) }))
      .sort((p, q) => p.L.cost - q.L.cost);
    candsMemo = key === null ? null : { graph, key, cands };
  }
  return { graph, routeOptions, evalState, useStreets, usable, cands, iterations, restarts, seed, candidateLimit, snapshotMs, onSnapshot };
}

const keep = (st, layout) => ({ layout, rows: clone(st.rows), pads: { ...st.pads }, blocks: { ...st.blocks }, streets: [...(st.streets || [])] });

/** 两个列表逐项相同 */
const sameList = (a, b) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** 两个对象的键（连先后次序）和值都相同；same 比较值 */
const sameDict = (a, b, same) => {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (!sameList(ka, Object.keys(b))) return false;
  for (const k of ka) if (!same(a[k], b[k])) return false;
  return true;
};
const sameBlock = (a, b) => a === b || sameDict(a, b, (x, y) => x === y);
/**
 * 邻域动作有时没改状态：空列改成原来的值、只有一块的行镜像、一块和自己交换、挪回原位……（退火里约 7%~11% 的步）。
 * route() 是确定的，只看行、块、空列和辅路，这时结果和当前状态的一模一样，不用再算一遍。
 * 键的先后次序也要一样（route 里遍历块、空列的次序会影响结果），比较得严一点只会少省几次，不会改结果。
 */
function sameState(a, b) {
  if (a.rows !== b.rows) {
    if (a.rows.length !== b.rows.length) return false;
    for (let i = 0; i < a.rows.length; i++) if (!sameList(a.rows[i], b.rows[i])) return false;
  }
  return sameDict(a.pads || {}, b.pads || {}, (x, y) => x === y) && sameDict(a.blocks || {}, b.blocks || {}, sameBlock) && sameList(a.streets || [], b.streets || []);
}
const better = (a, b) => (a.feasible !== b.feasible ? a.feasible : a.cost < b.cost);

/** 0..65535 的整数（−0 也算 0：route 里空列、台数、辅路的 −0 和 0 算出来一样） */
const small = (v) => (v & 0xffff) === v;
/**
 * 同一轮退火里评估过的排法：记下 route() 问过的代价下限（opt.rejectFloor 收到的 floor，按先后）和算完时的代价。
 * 冷下来以后当前状态常常几百步不动，邻域就那么些，同一个邻居会被提好几次（细档 8000 步：电磁涡轮、粒子容器约两成的评估、
 * 引力矩阵约 8%，快档 1500 步约 5%~13%），再被提出时按记下的数判，不用再算（见 runRound 的 evalSearch）。
 * 2026/10/07 量（单线程，同一进程里自己计时）：省下搜索里 route() 时间的 引力矩阵 30 塔 5%~6.5%、电磁涡轮 90 10%~16%、粒子容器 60 6%~15%（快档~细档），
 * 算键另花 1%~2%。
 * 键和 sameState 一样严：各行的块 ID（按先后）、空列和块（按对象里键的先后，块记组和台数，route 只读这两项）、辅路，
 * 逐字一样才算同一个排法。块 ID、组 ID 按第一次出现编成从 1 起的小整数，连同各段的个数和数值逐个编成一个字符
 * （都要是 0..65535 的整数，否则不记、照常算）。记下的只有下限和代价这几个数，不是布局本身，不占多少地方。
 * 表满 limit 个就整张挪去旧表、开新表，最多记 2 × limit 个（同一个排法隔得最远的也就两千多次评估）
 */
function stateMemo(limit = 2048) {
  const ids = new Map();
  const id = (s) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size + 1));
    return v;
  };
  const buf = [];
  let now = new Map();
  let old = new Map();
  const set = (k, e) => {
    now.set(k, e);
    if (now.size >= limit) {
      old = now;
      now = new Map();
    }
  };
  return {
    set,
    get(k) {
      let e = now.get(k);
      if (e === undefined && (e = old.get(k)) !== undefined) set(k, e);
      return e;
    },
    /** 排法的键；有别的值（不是 0..65535 的整数、块不是 { gid, n }）时返回 null，不记 */
    key(x) {
      const { rows, pads, blocks } = x;
      const streets = x.streets || [];
      if (!blocks || !pads || !small(rows.length) || !small(streets.length)) return null;
      buf.length = 0;
      buf.push(rows.length);
      for (const row of rows) {
        if (!small(row.length)) return null;
        buf.push(row.length);
        for (const bid of row) buf.push(id(bid));
      }
      // 空列、块按对象里的先后逐个编（和 sameState 一样严：键的先后不同就算不同的排法），个数先占一格、编完再填
      let at = buf.length;
      let n = 0;
      buf.push(0);
      for (const bid in pads) {
        const v = pads[bid];
        if (!small(v)) return null;
        buf.push(id(bid), v);
        n++;
      }
      if (!small(n)) return null;
      buf[at] = n;
      at = buf.length;
      n = 0;
      buf.push(0);
      for (const bid in blocks) {
        const b = blocks[bid];
        if (!b || typeof b.gid !== 'string' || !small(b.n)) return null;
        buf.push(id(bid), id(b.gid), b.n);
        n++;
      }
      if (!small(n)) return null;
      buf[at] = n;
      buf.push(streets.length);
      for (const v of streets) {
        if (!small(v)) return null;
        buf.push(v);
      }
      if (ids.size > 0xffff) return null;
      return String.fromCharCode.apply(null, buf);
    },
  };
}

/** 候选存档：每种宽 × 高留代价最低的一个，最多 limit 个（超出时删掉最差的）。最终放站和供电后再决定用哪个 */
function makeArchive(limit) {
  const map = new Map();
  return {
    map,
    remember(st, L) {
      if (!L.feasible) return;
      const k = `${L.width}:${L.height}`;
      if (!map.has(k) || L.cost < map.get(k).layout.cost) map.set(k, keep(st, L));
      if (map.size > limit) {
        const worst = [...map.entries()].sort((a, b) => b[1].layout.cost - a[1].layout.cost)[0][0];
        map.delete(worst);
      }
    },
  };
}

/** 第 s 轮退火：从第 s 个初始解出发（用完了就从扰动后的解出发），更新 archive，返回这一轮结束时的 best */
function runRound(P, s, roundEnd, archive, best) {
  const { graph, routeOptions, evalState, useStreets, usable, cands, iterations, seed, snapshotMs, onSnapshot } = P;
  const rand = rng(seed + s * 1013);
  let st = cands[s % cands.length].st;
  if (s >= cands.length) for (let k = 0; k < 10; k++) st = neighbor(graph, st, rand, usable, useStreets);
  let cur = evalState(st);
  const t0 = Math.max(20, cur.cost * 0.05);
  const t1 = 0.5;
  let T = t0;
  // 提前拒绝：评估邻域时 route() 的打分一步算到「代价下限 floor」就问一句（layout/score.js 的 rejectFloor）。
  // floor 比当前代价高时，下面的接受判断一定会抽一个随机数 u，并且只在 u < exp((当前 − 代价) / T) 时接受；
  // 先偷看这个 u（不往前走），按 floor 算都接受不了（留 1e-9 的余量，盖过 exp、log 的舍入）就一定被拒，后面最费时的几步不用算。
  // 被拒的这一步照样抽掉这个 u，随机数序列和存档、best 都和算完再拒一模一样
  const rejects = (floor) => floor > cur.cost && (cur.cost - floor) / T < Math.log(rand.peek()) - 1e-9;
  let floors = null; // 这次 route() 问过的下限（记进 memo）
  const searchOptions = {
    ...routeOptions,
    rejectFloor: (floor) => {
      if (floors) floors.push(floor);
      return rejects(floor);
    },
  };
  // 同一个排法再被提出时（stateMemo），route() 是确定的，重算一定得到同样的下限和代价，所以按记下的数照原来的规则判：
  //   记下的下限有一个现在会被提前拒绝 → 原来也在那一步返回 rejected；
  //   都不拒、又算完过：接受判断按下面循环里的式子先偷看那个随机数，不接受 → 原来也是抽掉这个数、什么都不动，直接按 rejected 返回；
  //   接受：是最近接受过的几个排法之一（逐字一样，键的先后也一样，和下面的 sameState 一样严）就直接用它当时的结果，
  //         和上面「没改状态时沿用当前结果」同一个道理（平台上 A、B 代价相等，常来回接受）；否则、或者没算完过 → 照常调 route()，结果逐字一样。
  // 按 rejected 返回时循环照样只抽掉一个随机数，随机数序列、状态、存档和 best 都和重算一模一样
  const memo = stateMemo();
  const recent = [{ st, L: cur }]; // 最近接受的 4 个排法和结果（布局只读，共用不会被改）
  const evalSearch = (x) => {
    const key = memo.key(x);
    const seen = key === null ? undefined : memo.get(key);
    if (seen) {
      for (const f of seen.floors) if (rejects(f)) return { rejected: true, cost: f };
      if (seen.cost !== undefined) {
        if (!(seen.cost <= cur.cost || rand.peek() < Math.exp((cur.cost - seen.cost) / T))) return { rejected: true, cost: seen.cost };
        for (const r of recent) if (sameState(r.st, x)) return r.L;
      }
    }
    floors = [];
    const L = route(graph, x.rows, searchOptions, x.pads, x.blocks, x.streets || []);
    if (key !== null) memo.set(key, { floors, cost: L.rejected ? undefined : L.cost });
    floors = null;
    return L;
  };
  // 实时预览的快照：借每 32 步那次时间检查，到点把当前状态交给钩子（只读，开不开结果逐字一致）
  let nextSnap = onSnapshot && snapshotMs > 0 ? Date.now() + snapshotMs : Infinity;
  let accepted = 0;
  for (let i = 0; i < iterations; i++) {
    if ((i & 31) === 0) {
      const now = Date.now();
      if (now > roundEnd) break;
      if (now >= nextSnap) {
        nextSnap = now + snapshotMs;
        onSnapshot({ graph, s, i, iterations, T: t0 * Math.pow(t1 / t0, i / iterations), layout: cur, cost: cur.cost, best: best.layout, bestCost: best.layout.cost, feasible: cur.feasible, accepted });
      }
    }
    T = t0 * Math.pow(t1 / t0, i / iterations);
    const cand = neighbor(graph, st, rand, usable, useStreets, cur.hot);
    // 没改状态时直接沿用当前的结果：代价相等，下面的接受判断在 rand() 之前就成立，随机数、存档、best 都和重算一样
    const L = sameState(cand, st) ? cur : evalSearch(cand);
    if (L.rejected) {
      rand(); // 注定被拒：抽掉接受判断本来要抽的那个随机数
      continue;
    }
    if (L.cost <= cur.cost || rand() < Math.exp((cur.cost - L.cost) / T)) {
      if (L !== cur) {
        recent.push({ st: cand, L });
        if (recent.length > 4) recent.shift();
      }
      st = cand;
      cur = L;
      accepted++;
      archive.remember(st, cur);
      if (better(cur, best.layout)) best = keep(st, cur);
    }
  }
  return best;
}

/** 收尾：同一行里紧挨着的同组两块（中间没空列）合成一块，几何完全不变，只是让结果更干净；再挑出存档里的候选 */
function conclude(P, best, history, archive) {
  const { evalState, cands } = P;
  for (const c of cands) if (better(c.L, best.layout)) best = keep(c.st, c.L);
  const st = { rows: clone(best.rows), pads: { ...best.pads }, blocks: { ...best.blocks }, streets: [...(best.streets || [])] };
  let changed = false;
  for (const row of st.rows) {
    for (let i = row.length - 1; i > 0; i--) {
      const a = row[i - 1];
      const b = row[i];
      if (st.blocks[a].gid === st.blocks[b].gid && !st.pads[b]) {
        st.blocks[a] = { ...st.blocks[a], n: st.blocks[a].n + st.blocks[b].n };
        delete st.blocks[b];
        row.splice(i, 1);
        changed = true;
      }
    }
  }
  if (changed) {
    const L = evalState(st);
    if ((L.feasible || !best.layout.feasible) && L.cost <= best.layout.cost + 1e-9) best = keep(st, L);
  }
  return { ...best, history, candidates: [...archive.map.values()].sort((a, b) => a.layout.cost - b.layout.cost) };
}

/**
 * 单线程搜索：restarts 轮退火依次跑，存档和 best 多轮共用。
 * @returns {{layout: ReturnType<typeof route>, rows: string[][], pads: object, blocks: object, history: number[], candidates: object[]}}
 */
export function optimize(graph, options = {}) {
  const P = prepare(graph, options);
  // 时间上限（毫秒）：大产线到点就收手，返回当时最好的解；每轮平分剩余时间
  const deadline = options.timeLimit ? Date.now() + options.timeLimit : Infinity;
  const archive = makeArchive(P.candidateLimit);
  for (const c of P.cands) archive.remember(c.st, c.L);
  let best = keep(P.cands[0].st, P.cands[0].L);
  const history = [];
  for (let s = 0; s < P.restarts; s++) {
    const roundEnd = Math.min(deadline, Date.now() + (deadline - Date.now()) / Math.max(1, P.restarts - s));
    best = runRound(P, s, roundEnd, archive, best);
    history.push(best.layout.cost);
  }
  return conclude(P, best, history, archive);
}

/**
 * 并行搜索的一份活：只跑 rounds 里列出的那几轮（各轮各自一份存档和 best），交给 mergeRounds 合并。
 * 给后台线程用：输入输出都能被结构化克隆。
 */
export function searchRounds(graph, options = {}, rounds = []) {
  const P = prepare(graph, options);
  const deadline = options.timeLimit ? Date.now() + options.timeLimit : Infinity;
  return rounds.map((s, i) => {
    const archive = makeArchive(P.candidateLimit);
    for (const c of P.cands) archive.remember(c.st, c.L);
    // 这个线程分到的几轮平分剩余时间
    const roundEnd = Math.min(deadline, Date.now() + (deadline - Date.now()) / Math.max(1, rounds.length - i));
    const best = runRound(P, s, roundEnd, archive, keep(P.cands[0].st, P.cands[0].L));
    return { s, best, archive: [...archive.map.values()] };
  });
}

/**
 * 合并各线程跑出来的轮次：按轮次顺序取 best（严格更好才换，和单线程一样平局留先跑的），
 * 存档按宽 × 高取代价最低的、保留前 candidateLimit 个。没有时间上限时结果与 optimize 完全一致。
 */
export function mergeRounds(graph, options = {}, parts = []) {
  const P = prepare(graph, options);
  const sorted = parts.slice().sort((a, b) => a.s - b.s);
  const archive = makeArchive(P.candidateLimit);
  for (const c of P.cands) archive.remember(c.st, c.L);
  let best = keep(P.cands[0].st, P.cands[0].L);
  const history = [];
  for (const part of sorted) {
    for (const e of part.archive) {
      const k = `${e.layout.width}:${e.layout.height}`;
      const old = archive.map.get(k);
      if (!old || e.layout.cost < old.layout.cost) archive.map.set(k, e);
    }
    if (better(part.best.layout, best.layout)) best = part.best;
    history.push(best.layout.cost);
  }
  const top = [...archive.map.entries()].sort((a, b) => a[1].layout.cost - b[1].layout.cost).slice(0, P.candidateLimit);
  archive.map.clear();
  for (const [k, v] of top) archive.map.set(k, v);
  return conclude(P, best, history, archive);
}
