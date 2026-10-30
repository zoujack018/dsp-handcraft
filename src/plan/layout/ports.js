// 出入口：紧凑布局接到左右边缘；物流站靠左侧时排站、分站口和车道
import { STATION_SIZE, gk, keepFreeSlot, permutations, stationItemCap } from './shared.js';
import { STATION_GAP, realItem } from '../../gamedata.js';

// 地面占用表的缓冲区按线程复用（和 elevation.js 的归属表一样）：每次 placePorts 换一个代际，代际不同就当空着，不用清零。
// usedBuf 是站口方案（tryPlan）试算时已占的地面格，同样大小、同样编号，每试一个方案换一个戳
let groundBuf = new Int32Array(0);
let usedBuf = new Int32Array(0);
let groundGen = 0;
let usedStamp = 0;
/** 备好够大的表，返回这一次的代际（表就是 groundBuf） */
function groundGrid(size) {
  // 一次 placePorts 最多试 3 × (2 × 高度 + 1) 个方案，戳离上限留足余量
  if (groundBuf.length < size || groundGen >= 1e9 || usedStamp >= 1e9) {
    const n = Math.max(size, Math.ceil(groundBuf.length * 1.5));
    groundBuf = new Int32Array(n);
    usedBuf = new Int32Array(n);
    groundGen = 0;
    usedStamp = 0;
  }
  return ++groundGen;
}

// 热路径里的循环都写成下标循环：for…of 在 placePorts 这个大函数里没被优化掉，每个循环都建一个迭代器、每一步一个 {value, done}
// （2026/10/25 量过：普通布局每次 route() 约 6 KB）。下面几块共用的数组也是为了压每次 route() 的短命对象，同一线程里 placePorts 不会重入

/** 热点里反复用的临时整数数组：长度不够时换一块更长的，各次调用共用（用完即弃） */
const SCRATCH = [];
const scratch = (slot, n) => {
  let a = SCRATCH[slot];
  if (!a || a.length < n) a = SCRATCH[slot] = new Int32Array(Math.max(n, 64));
  return a;
};
/** 同样各次调用共用的普通数组（放带子对象、行号这些要原样保留的值）：都是先写后读，只读这一次写过的前几项 */
const LISTS = [];
const list = (slot) => (LISTS[slot] ??= []);

// 侧边总线（groupPorts）里总线的口占掉的行（used）、要让开的行（avoid）：按行号的戳数组，每次 placePorts 换一个戳，不用清零。
// 整数行号 0..长度−1 记在这里；别的值（不是整数、NaN、负数，几乎不会）记在各自用到才建的 Set 里，和原来的 Set 一样比（SameValueZero）
let rowUsed = new Int32Array(0);
let rowAvoid = new Int32Array(0);
let rowStamp = 0;

/** 右侧 3 个站口按目标行从低到高试的下中上排列：带数 n（0~3）→ 排列表（只读，各次共用） */
const RIGHT_DYS = [0, 1, 2, 3].map((n) => permutations([-1, 0, 1]).map((p) => p.slice(0, n)));
/** 右侧站口：上中下 → 11/10/9 号口 */
const RIGHT_SLOT = { 1: 11, 0: 10, [-1]: 9 };
/** 车道的口：往上 0/1/2 号、往下 8/7/6 号（第 i 条车道，只读） */
const UP_SLOTS = [0, 1, 2];
const DOWN_SLOTS = [8, 7, 6];
/** 每座站最多几条带：先按 9 条分，接不全再试 6、4 条（只读） */
const CAPS = [9, 6, 4];
/** 同一列相邻两站的中心至少隔 STATION_GAP（取整到 24 行，游戏规则） */
const PITCH = Math.max(STATION_SIZE + 1, Math.ceil(STATION_GAP));

/** 站位里往下推一遍：每座站不低于 3、不低于前一座 + PITCH（和原来 c.forEach((v, k) => (c[k] = Math.max(v, 3, …))) 一样，v 是这一格当时的值） */
const fwdCenters = (c, n) => {
  for (let k = 0; k < n; k++) c[k] = Math.max(c[k], 3, k ? c[k - 1] + PITCH : -Infinity);
};
/** 两份站位的前 n 项一样（NaN 也当相同，和原来 centers.every 里比的一样） */
const sameCenters = (a, b, n) => {
  for (let k = 0; k < n; k++) {
    const v = a[k];
    const w = b[k];
    if (!(v === w || (v !== v && w !== w))) return false;
  }
  return true;
};

/**
 * 站口方案（tryPlan 试算的、选中的）：原来每个方案建 plan、orphans 数组，plan 里每条带一个 {leg, k, slot, py, stub}、stub 是一串 [x, y] 小数组。
 * 现在只记紧凑的描述（第 i 条的 leg、k、slot、py 和车道的 x0、sy、up、nv 各记在同名数组的第 i 项，前 n 项是这个方案的；
 * up 是车道往上 1、往下 −1，右侧口记 0），stub 到落实时才按同样的格子、同样的先后建（见 sideStations 末尾）。
 * 两份交替用：试算写进备用的那份，选上了就和选中的那份对调（选中的那份不再被试算改动）；orphans 是分不到口的带，前 nOrph 项，先后不变。
 * cost、groups、cen（站位的一份拷贝）只在选中时写
 */
const planBuf = () => ({ n: 0, leg: [], k: [], slot: [], py: [], x0: [], sy: [], up: [], nv: [], nOrph: 0, orph: [], cost: 0, groups: null, cen: [] });
const PLANS = [planBuf(), planBuf()];
/** 站位：centersFor 交替写这两份（当前、上一个），和上一个比去重 */
const CEN_A = [];
const CEN_B = [];

/** route() 的一步：读写共享的布局上下文 c */
export function placePorts(c) {
  const { P, addPenalty, atPort, corridor, labGaps, legs, opt, segments, side, stationX, xL, xR } = c;
  let { height } = c; // 物流站靠左侧时，站叠起来比生产区高，要把布局加高
  // ---------- E. 高架段与出入口 ----------
  // 地面上已占用的带子格：按 (x, y) 编成一维下标的 Int32Array（代替数字键的 Set，退火里每次 route() 都要把所有段的格子记一遍）。
  // 表按布局四周各留 GM 格；物流站靠左侧时站叠起来可能比生产区高，按最多的站数留够高度。万一超出表的范围，退回 Set（用到才建），结果和原来一样
  const GM = 16;
  const GW = xR + 2 + 2 * GM;
  const GH = (side ? Math.max(height, (legs.length + 2) * PITCH) : height) + 2 * GM;
  const gen = groundGrid(GW * GH);
  const G = groundBuf;
  let far = null;
  const onGround = (x, yy) => {
    const gx = x + GM;
    const gy = yy + GM;
    return gx >= 0 && gy >= 0 && gx < GW && gy < GH ? G[gx * GH + gy] === gen : far !== null && far.has(gk(x, yy));
  };
  const putGround = (x, yy) => {
    const gx = x + GM;
    const gy = yy + GM;
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) G[gx * GH + gy] = gen;
    else (far ??= new Set()).add(gk(x, yy));
  };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    for (let x = s.a; x <= s.b; x++) putGround(x, s.y);
  }
  // 研究站夹带（layout/belts.js 的 labGaps）：那一列的地面格；它的高架从带尾原地升起、往北一格到上方通道第一条轨头顶（gapOut 那一行）再拐向出口
  if (labGaps) for (let i = 0; i < labGaps.length; i++) for (let y = labGaps[i].y0; y <= labGaps[i].y1; y++) putGround(labGaps[i].x, y);
  /** 夹带那段高架水平走的那一行（当段尾所在的行用） */
  const gapRow = (leg) => labGaps[leg.gap].y1 + 1;
  const ports = [];
  // 出入口这一格和它竖直方向上斜坡顶那一格的地面都要空着（原来写在 portY 里，每次调用新建一个；height 照样按调用时的值读）
  const portOk = (xe, y0, yy) => {
    if (yy < 0 || yy >= height) return false;
    const up = yy === y0 ? null : yy + Math.sign(y0 - yy);
    return !onGround(xe, yy) && (up === null || !onGround(xe, up));
  };
  /** 边缘列上找一个地面空格做出入口，优先与段同一行 */
  const portY = (xe, y0) => {
    // 同一行最好；其次隔 2 行以上（斜坡升到高处先直走再拐）；隔 1 行时斜坡顶就是拐角，放最后
    if (portOk(xe, y0, y0)) return y0;
    for (let dy = 2; dy <= height + 1; dy++) {
      if (portOk(xe, y0, y0 - dy)) return y0 - dy;
      if (portOk(xe, y0, y0 + dy)) return y0 + dy;
    }
    if (portOk(xe, y0, y0 - 1)) return y0 - 1;
    if (portOk(xe, y0, y0 + 1)) return y0 + 1;
    return y0;
  };
  /** endX + d 到 col（含两端）这一行地面是否都空着 */
  const rowFree = (endX, d, col, y) => {
    const step = col >= endX + d ? 1 : -1;
    for (let x = endX + d; x !== col + step; x += step) if (onGround(x, y)) return false;
    return true;
  };
  /** 把段的端头沿地面一直接到 col（这一行地面都空着时），返回是否接上了；夹带的高架不落地接（它是竖着进上方通道的） */
  const groundTo = (leg, s, col) => {
    if (leg.gap != null) return false;
    let endX = leg.kind === 'in' ? s.entryX : s.exitX;
    const d = leg.kind === 'in' ? -s.dir : s.dout;
    if (atPort(endX, col)) return true;
    if ((col - endX) * d <= 0) return false;
    if (!rowFree(endX, d, col, s.y)) return false;
    // 原来是 for (const x of line(endX + d, col))：按 line 同样的步进和终止条件直接走，不建数组
    const from = endX + d;
    const step = col >= from ? 1 : -1;
    for (let x = from; x !== col + step; x += step) putGround(x, s.y);
    if (d > 0) s.b = col;
    else s.a = col;
    if (leg.kind === 'in') s.entryX = col;
    else s.exitX = col;
    return true;
  };
  const stations = []; // 物流站：{x, y, items: [{itemId, role}], ports: [{slot, legId}]}
  if (!side) {
    // 侧边总线（用户 2026/10/24「同一种原料的几个入口挨在一起」，opt.groupPorts；layout/belts.js 让这种原料都从右边进）：
    // 口全放在右边布局外最外那一列、相邻的几行；每条带从口进来原地升起往里走到自己那一列（xR + 1 起，每条一列），
    // 沿这一列竖着走到自己那段的行，再往里走到段首落下（layout/elevation.js）。往上走的、往下走的各排一边，离得近的走里面那列、
    // 口挨着中间：同一种原料的几条带互不交叉，第 1 层就够。几种原料的总线往外一组接一组，口都在最外那一列、各占不相交的几行。
    // 别的从右边进出的口不放总线口那几行（往外接的那一行要穿过总线的口）
    // 总线也可以排左边（route.js 的 busSide 'auto'，试验开关）：从左边缘进的照样分组，镜像排在左边布局外（xL − 1 起往外，口在 x < 0）。
    // 出入口都在左边（leftPorts，箱子供货的左侧仓列）时左边不排：仓组照旧接各自的口
    if (opt.groupPorts && !opt.freeEnds) {
      groupPorts(1);
      if (opt.busSide === 'auto' && !opt.leftPorts) groupPorts(-1);
    }
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (leg.kind === 'link' || leg.bus != null || leg.gap != null) continue; // 夹带的在下面最后排
      const s = segments[leg.kind === 'in' ? leg.to : leg.from];
      if (opt.freeEnds) {
        // 边缘放站：不接到边缘，段的端头就是出入口，站排好之后直接用 A* 接到这里
        leg.direct = true;
        leg.py = s.y;
        leg.edge = leg.kind === 'in' ? s.entryX : s.exitX;
        ports.push({ kind: leg.kind, itemId: leg.itemId, x: leg.edge, y: leg.py, rate: leg.rate, leg: leg.id, direct: true });
        continue;
      }
      // 这一行地面一直到边缘都空着：直接用地面带接到边缘，省掉抬升和落下
      if (groundTo(leg, s, leg.edge)) {
        // 段的端头已经在边缘列：端头这一格就是出入口
        leg.direct = true;
        leg.py = s.y;
        leg.edge = leg.kind === 'in' ? s.entryX : s.exitX;
      } else {
        leg.py = portY(leg.edge, s.y);
        putGround(leg.edge, leg.py);
        // 斜坡顶那一格的地面也留着，别的出入口不放在它下面
        if (leg.py !== s.y) putGround(leg.edge, leg.py + Math.sign(s.y - leg.py));
      }
      ports.push({ kind: leg.kind, itemId: leg.itemId, x: leg.edge, y: leg.py, rate: leg.rate, leg: leg.id, direct: !!leg.direct });
    }
    // 研究站夹带：边缘放站时出入口就是带尾那格（原地升起那格，站的接线从上方接进来，plan/stations.js），否则在边缘列上找口。
    // 放在别的口后面：它沿上方通道第一条轨那一行走到边缘，先占了口的话，那条轨上本来能沿地面直接接到边缘的段就得升起来，两头互相压着升降叠排不开
    if (labGaps) {
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (leg.gap == null) continue;
        const gp = labGaps[leg.gap];
        if (opt.freeEnds) {
          leg.direct = true;
          leg.py = gp.y1;
          leg.edge = gp.x;
        } else {
          // 同一行几条夹带都往近的那边出时，那一列边缘可能没有空格了（portY 找不到会退回压在别的口上）：换到另一边试，
          // 两边都没有就按走不通罚（出入口都在左边时只试左边）
          const y = gapRow(leg);
          let py = portY(leg.edge, y);
          if (!portOk(leg.edge, y, py) && !opt.leftPorts) {
            const other = leg.edge === xL ? xR : xL;
            const q = portY(other, y);
            if (portOk(other, y, q)) {
              leg.edge = other;
              gp.dout = -gp.dout;
              py = q;
            } else addPenalty('route', P.route, `${c.graph.items.get(leg.itemId).name} 的夹带在边缘找不到出口`, c.itemBids(leg.itemId));
          } else if (!portOk(leg.edge, y, py)) addPenalty('route', P.route, `${c.graph.items.get(leg.itemId).name} 的夹带在边缘找不到出口`, c.itemBids(leg.itemId));
          leg.py = py;
          putGround(leg.edge, leg.py);
          if (leg.py !== y) putGround(leg.edge, leg.py + Math.sign(y - leg.py));
        }
        ports.push({ kind: leg.kind, itemId: leg.itemId, x: leg.edge, y: leg.py, rate: leg.rate, leg: leg.id, direct: !!leg.direct });
      }
    }
  } else sideStations();
  // 逐个写回（和 Object.assign(c, { ports, stations, height }) 按同样的先后写同样的字段）
  c.ports = ports;
  c.stations = stations;
  c.height = height;

  /**
   * 侧边总线（见上面调用处）。原来按原料建 Map、各组 filter / sort、口的行放在 Set、方案放在 busPlans 里；现在都换成共用的数组和行号戳，
   * 算法、先后不变：组按第一次出现的先后（和 Map 的插入先后一样），组里的带按 legs 的先后；排序都是稳定的插入排序、比较式照抄
   * （值都是整数行号，和 sort 的结果一样）。没有哪种原料有 ≥ 2 条从右边缘进的带时整块不改任何状态（avoid 只经 pick 用、pick 只对
   * ≥ 2 条的原料调，used、busPlans 都空着），直接返回。
   * sd：1 右边（边缘列 xR，总线的列 xR + 1 起往右），−1 左边（边缘列 xL，xL − 1 起往左，busSide 'auto' 才排）；两边的口各占各的行，互不相干
   */
  function groupPorts(sd) {
    const xe = sd > 0 ? xR : xL; // 这一边的边缘列
    // 从这一边边缘进的原料带按原料（realItem）分组：第 i 条带在第 of[i] 组（别的带 −1），第 j 组的原料是 keys[j]、有 cnt[j] 条
    const of = scratch(0, legs.length);
    const keys = list(0);
    const cnt = scratch(1, legs.length);
    let ng = 0;
    let any = false;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      of[i] = -1;
      if (leg.kind !== 'in' || leg.edge !== xe) continue;
      const k = realItem(leg.itemId);
      let j = 0;
      while (j < ng && !(keys[j] === k || (k !== k && keys[j] !== keys[j]))) j++; // Map 的键比法（SameValueZero）
      if (j === ng) {
        keys[ng] = k;
        cnt[ng++] = 0;
      }
      of[i] = j;
      if (++cnt[j] >= 2) any = true;
    }
    if (!any) return;
    // 行号戳：总线的口占掉的行（used，插入的先后另记在 usedRows 的前 nUsed 项，后面按这个先后标地面）、别的口要让开的行（avoid）
    const need = height >= 0 && height < 1e6 ? Math.ceil(height) + 1 : 0; // 高度不是这样的数时（几乎不会）不扩，表外的行都进 Set
    if (rowUsed.length < need || rowStamp >= 1e9) {
      const n = Math.max(64, need, Math.ceil(rowUsed.length * 1.5));
      rowUsed = new Int32Array(n);
      rowAvoid = new Int32Array(n);
      rowStamp = 0;
    }
    const rst = ++rowStamp;
    const RU0 = rowUsed;
    const RA0 = rowAvoid;
    const RN = RU0.length;
    let usedOdd = null;
    let avoidOdd = null;
    const usedRows = list(1);
    let nUsed = 0;
    const isRow = (y) => (y | 0) === y && y >= 0 && y < RN;
    /** used.add(y)：已经有了就不再记（和 Set 一样，先后按第一次加进来的） */
    const addUsed = (y) => {
      if (isRow(y)) {
        if (RU0[y] === rst) return;
        RU0[y] = rst;
      } else {
        if (usedOdd !== null && usedOdd.has(y)) return;
        (usedOdd ??= new Set()).add(y);
      }
      usedRows[nUsed++] = y;
    };
    // 别的从这一边进出的口多半落在自己那段的行（段本来就伸到边缘列时只能在那一行）：总线的口不放这几行，不然正好挡在它外面
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (leg.kind === 'link' || leg.edge !== xe) continue;
      if (leg.kind === 'in' && cnt[of[i]] > 1) continue;
      const y = leg.gap != null ? gapRow(leg) : segments[leg.kind === 'in' ? leg.to : leg.from].y;
      if (isRow(y)) RA0[y] = rst;
      else (avoidOdd ??= new Set()).add(y);
    }
    const blocked = (y) => y < 0 || y >= height || (isRow(y) ? RU0[y] === rst || RA0[y] === rst : (usedOdd !== null && usedOdd.has(y)) || (avoidOdd !== null && avoidOdd.has(y)));
    /**
     * 从 y 起往 dir 那边挑 n 行能放口的（跳过放不了的，连着跳过不超过 3 行：用户说两个口中间空不超过 3 行就行），依次写进 out，返回挑了几行；
     * 挑不够返回 −1（原来返回挑到的行的数组、挑不够返回 null；n 为 0 时是空数组，照样算挑到了）
     */
    const pick = (y, dir, n, out) => {
      let m = 0;
      for (let skip = 0; m < n; y += dir) {
        if (y < 0 || y >= height) return -1;
        if (!blocked(y)) {
          out[m++] = y;
          skip = 0;
        } else if (++skip > 3) return -1;
      }
      return m;
    };
    const yOf = (l) => segments[l.to].y;
    // 这一组的带（ls）、排好的行（ys）、往上那组（up）、往下那组（dn）、两组挑到的行（ru、rd）；方案（原来的 busPlans）记在 bLeg、bPy、bCol 的前 nb 项
    const ls = list(2);
    const ys = list(3);
    const up = list(4);
    const dn = list(5);
    const ru = list(6);
    const rd = list(7);
    const bLeg = list(8);
    const bPy = list(9);
    const bCol = list(10);
    let nb = 0;
    let off = xe; // 下一组总线从哪一列往外排（往 sd 那边）
    for (let j = 0; j < ng; j++) {
      if (cnt[j] < 2) continue;
      let n = 0;
      for (let i = 0; i < legs.length; i++) if (of[i] === j) ls[n++] = legs[i];
      // ys：各条带的行从小到大（原来 ls.map(yOf).sort((a, b) => a - b)）
      for (let i = 0; i < n; i++) {
        const y = yOf(ls[i]);
        let q = i - 1;
        while (q >= 0 && ys[q] - y > 0) {
          ys[q + 1] = ys[q];
          q--;
        }
        ys[q + 1] = y;
      }
      const mid = ys[(n - 1) >> 1];
      // up：行不低于中位数的，近的在前（原来 filter 再 sort((a, b) => yOf(a) − yOf(b))）；dn：低于中位数的，近的在前（sort((a, b) => yOf(b) − yOf(a))）
      let nu = 0;
      let nd = 0;
      for (let i = 0; i < n; i++) {
        const l = ls[i];
        if (yOf(l) >= mid) {
          let q = nu - 1;
          while (q >= 0 && yOf(up[q]) - yOf(l) > 0) {
            up[q + 1] = up[q];
            q--;
          }
          up[q + 1] = l;
          nu++;
        }
        if (yOf(l) < mid) {
          let q = nd - 1;
          while (q >= 0 && yOf(l) - yOf(dn[q]) > 0) {
            dn[q + 1] = dn[q];
            q--;
          }
          dn[q + 1] = l;
          nd++;
        }
      }
      // 往上那组从 at 起往上挑、往下那组从 at − 1 起往下挑；at 从中位数那一行往两边找（k = 0 只试中位数，之后先 mid − k 再 mid + k），
      // 两组之间也不空超过 3 行。往上那组挑不到就不用挑往下那组（pick 不改状态，原来 ru && pick(…) 也不挑）
      let got = false;
      let nru = 0;
      let nrd = 0;
      for (let k = 0; k <= height && !got; k++)
        for (let q = 0; q < (k ? 2 : 1); q++) {
          const at = k ? (q ? mid + k : mid - k) : mid;
          nru = pick(at, 1, nu, ru);
          if (nru < 0) continue;
          nrd = pick(at - 1, -1, nd, rd);
          if (nrd < 0) continue;
          if (nru && nrd && ru[0] - rd[0] - 1 > 3) continue;
          got = true;
          break;
        }
      if (!got) continue; // 放不下：照旧各走各的
      for (let i = 0; i < nru; i++) addUsed(ru[i]);
      for (let i = 0; i < nrd; i++) addUsed(rd[i]);
      for (let i = 0; i < nd; i++) {
        bLeg[nb] = dn[i];
        bPy[nb] = rd[i];
        bCol[nb++] = off + sd * (1 + i);
      }
      for (let i = 0; i < nu; i++) {
        bLeg[nb] = up[i];
        bPy[nb] = ru[i];
        bCol[nb++] = off + sd * (1 + i);
      }
      off += sd * Math.max(nu, nd);
    }
    for (let i = 0; i < nb; i++) {
      const leg = bLeg[i];
      leg.edge = off + sd;
      leg.py = bPy[i];
      leg.bus = bCol[i];
      ports.push({ kind: 'in', itemId: leg.itemId, x: off + sd, y: bPy[i], rate: leg.rate, leg: leg.id, direct: false, bus: true });
    }
    for (let i = 0; i < nUsed; i++) putGround(xe, usedRows[i]); // 别的口不放这几行，也不直接接到这几行的边缘
  }

  /** E1. 物流站靠左侧（见下面的注释） */
  function sideStations() {
    // 站在最左侧 7 列（中心 x=3），第 7 列是主干走廊，生产区从第 8 列开始。站口：
    //   右侧 11/10/9 号口（中心 +2，上中下）经 +3 接到走廊；
    //   上侧 0/1/2 号口（中心 +2 行，右中左）各引一条地面车道沿站列往上，到目标行右拐接到走廊；
    //   下侧 8/7/6 号口同样往下（上下侧的口号是按逆时针编号推断的，待实测）。
    // 车道右拐不能互相交叉：往上的车道里最靠右的服务最低的行，往左依次更高；往下的同理。
    // 左侧的口朝着蓝图外面，不用。
    // 夹带（labGaps）的高架从带尾升起后在上方通道第一条轨头顶那一行走：当成段尾在那一行（groundTo、pathFree 对它都不落地接）
    const yOf = (l) => (l.gap != null ? gapRow(l) : segments[l.kind === 'in' ? l.to : l.from].y);
    const segOf = (l) => (l.gap != null ? { y: gapRow(l) } : segments[l.kind === 'in' ? l.to : l.from]);
    // 按真实物品和进出分（同 stations.js 的 stationGroups）：送出去的设为供应，要进的设为需求；副产物和产线自己要用的同种物品
    // 各占一格、不进同一座站（下面 groupBy；用户 2026/10/27：同一格里需求运来的料装满后副产物送不进去，那组工厂就停了）。
    // （原来先 filter 出非 link 的带再逐条放进 Map，再 [...entries()].map(…).sort(…)；现在按同样的先后直接放，
    // 平均行、供需的累加按原来 reduce 的先后逐条加，排序换成稳定的插入排序、比较式照抄）
    const byItem = new Map();
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      if (l.kind === 'link') continue;
      const k = l.kind === 'in' ? realItem(l.itemId) : -1 - realItem(l.itemId); // 送出去的键取负，和要进的分开
      let ls = byItem.get(k);
      if (!ls) byItem.set(k, (ls = []));
      ls.push(l);
    }
    /** 有送出去的带、且送出的不比要进的少：供应，否则需求（原来 ls.some(…) && ls.reduce(…) >= 0） */
    const roleOf = (ls) => {
      let out = false;
      for (let i = 0; i < ls.length && !out; i++) out = ls[i].kind === 'out';
      if (!out) return 'demand';
      let a = 0;
      for (let i = 0; i < ls.length; i++) a = a + (ls[i].kind === 'out' ? 1 : -1) * (ls[i].rate ?? 0);
      return a >= 0 ? 'supply' : 'demand';
    };
    const items = [];
    byItem.forEach((ls, key) => {
      const itemId = key < 0 ? -1 - key : key;
      let a = 0;
      for (let i = 0; i < ls.length; i++) a = a + yOf(ls[i]);
      const it = { itemId, legs: ls, y: a / ls.length, role: roleOf(ls) };
      let j = items.length - 1; // 原来 sort((a, b) => a.y − b.y)
      while (j >= 0 && items[j].y - it.y > 0) {
        items[j + 1] = items[j];
        j--;
      }
      items[j + 1] = it;
    });
    const col = corridor;
    const sx = stationX;
    const pathFree = (leg, s) => {
      if (leg.gap != null) return false;
      const endX = leg.kind === 'in' ? s.entryX : s.exitX;
      const d = leg.kind === 'in' ? -s.dir : s.dout;
      if (atPort(endX, col)) return true;
      if ((col - endX) * d <= 0) return false;
      return rowFree(endX, d, col, s.y);
    };
    // 分组：按目标行从低到高贪心装站，每座站最多 5 种物品（翘曲器格占一格时 4 种）、cap 条带（同种物品超过 9 条时拆到下一座站，那座站也存它）
    const slots = opt.station?.slots ?? null;
    const kinds = stationItemCap(slots);
    const groupBy = (cap) => {
      const groups = [];
      let cur = null;
      let n = 0;
      for (let q = 0; q < items.length; q++) {
        const it = items[q];
        for (let i = 0; i < it.legs.length; i += 9) {
          // 不超过 9 条时这一份就是整种物品：直接用 it（原来抄一份 {...it, legs: it.legs.slice(0, 9)}，键、值都一样；
          // 分组、站、试算只读它，谁都不改它和它的 legs）
          const part = it.legs.length <= 9 ? it : { ...it, legs: it.legs.slice(i, i + 9) };
          if (!cur || cur.length >= kinds || n + part.legs.length > cap || cur.some((q) => q.itemId === part.itemId && q.role !== part.role)) {
            groups.push((cur = []));
            n = 0;
          }
          cur.push(part);
          n += part.legs.length;
        }
      }
      return keepFreeSlot(groups, slots); // 喷增产剂时至少留一个空格给增产剂
    };
    /**
     * 每座站的中心行：尽量对准它那组带的平均行（mid：取整后的平均行，和平移无关，调用方先算好），相邻两站至少隔 PITCH（中间留出车道拐弯的空行）。
     * 写进 out 的前 mid.length 项（原来每次 map 一个新数组）
     */
    const centersFor = (mid, shift, out) => {
      const n = mid.length;
      for (let k = 0; k < n; k++) out[k] = mid[k] + shift;
      fwdCenters(out, n);
      for (let k = n - 1; k >= 0; k--) out[k] = Math.min(out[k], height - 4, k < n - 1 ? out[k + 1] - PITCH : Infinity);
      fwdCenters(out, n);
    };
    // ---- 试算一个站口方案（tryPlan）用的状态和小函数：原来每次 tryPlan 新建十来个闭包（use、isUsed、cellFree，每座站一个 assign、lanes，
    // 每条车道、每种排列一个 forEach 回调），现在每次 placePorts 建一次，状态放在这几个变量里，每个方案开头重写 ----
    let ust = 0; // 这个方案在 usedBuf 里的戳
    let farUsed = null; // 表外的格子（几乎不会）
    let cost = 0; // 这个方案目前的代价
    let T = PLANS[0]; // 这个方案写进哪一份描述
    // 方案里已占用的地面格（先把所有站体占上，车道不能穿过别的站）：记在 usedBuf 里，这个方案一个戳；表外的格子退回 Set
    const use = (x, yy) => {
      const gx = x + GM;
      const gy = yy + GM;
      if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) usedBuf[gx * GH + gy] = ust;
      else (farUsed ??= new Set()).add(gk(x, yy));
    };
    const isUsed = (x, yy) => {
      const gx = x + GM;
      const gy = yy + GM;
      return gx >= 0 && gy >= 0 && gx < GW && gy < GH ? usedBuf[gx * GH + gy] === ust : farUsed !== null && farUsed.has(gk(x, yy));
    };
    const cellFree = (x, yy) => yy >= 0 && yy < height && !onGround(x, yy) && !isUsed(x, yy);
    /** 方案里记一条带的站口（原来 plan.push({leg, k, slot, py, stub})）：车道记 x0、sy、up、nv，右侧口 up 记 0 */
    const record = (leg, k, slot, py, x0, sy, up, nv) => {
      const i = T.n++;
      T.leg[i] = leg;
      T.k[i] = k;
      T.slot[i] = slot;
      T.py[i] = py;
      T.x0[i] = x0;
      T.sy[i] = sy;
      T.up[i] = up;
      T.nv[i] = nv;
    };
    const orphan = (leg) => {
      T.orph[T.nOrph++] = leg;
    };
    // 每座站分池用的共用数组：near、right（原来 near.slice(0, 3) 再补）、ups、downs、spill
    const NEAR = list(11);
    const RIGHT = list(12);
    const UPS = list(13);
    const DOWNS = list(14);
    const SPILL = list(15);
    /**
     * 车道：up=1 往上（0/1/2 号口），up=-1 往下（8/7/6 号口）。离站近的车道用最靠右的口，拐弯不交叉。pool 的前 n 项是这一边的带，sy、k 是这座站。
     * stub（原来是一串 [x, y]）：竖直那段从 sy + 2·up 走到 py（sy + 2·up、sy + 3·up、出了站体的第一格 start 起每格 py += up 走到 py 之前那格，
     * 共 nv 格，再是 py），再是 x0 + 1 到 sx + 3 那一行（和 line(x0 + 1, sx + 3) 一样的步进）；这里按同样的格子、同样的先后标占用，
     * 长度 2 + nv + 1 + 那一行的格数，代价照原式子加
     */
    const lanes = (pool, n, up, sy, k) => {
      // 原来 pool.sort((a, b) => (yOf(a) − yOf(b)) × up)
      for (let i = 1; i < n; i++) {
        const l = pool[i];
        let j = i - 1;
        while (j >= 0 && (yOf(pool[j]) - yOf(l)) * up > 0) {
          pool[j + 1] = pool[j];
          j--;
        }
        pool[j + 1] = l;
      }
      let prev = up > 0 ? -Infinity : Infinity;
      for (let i = 0; i < n; i++) {
        const leg = pool[i];
        const dx = 1 - i;
        const slot = up > 0 ? UP_SLOTS[i] : DOWN_SLOTS[i];
        const s = segOf(leg);
        const x0 = sx + dx;
        const start = sy + 4 * up; // 出了站体的第一格
        const want = up > 0 ? Math.max(yOf(leg), start, prev + 1) : Math.min(yOf(leg), start, prev - 1);
        const st = sx + 3 >= x0 + 1 ? 1 : -1; // 右拐那一段的步进（和 line(x0 + 1, sx + 3) 一样；原来每格各算一遍，值一样）
        let nv = 0; // 原来 vert.push([x0, py]) 的次数
        let py = start;
        let ok = false;
        for (; py >= 0 && py < height; py += up) {
          if (!cellFree(x0, py)) break; // 竖直车道被挡住，再往外也过不去
          if ((py - want) * up >= 0) {
            // 右拐那一段（x0 + 1 到 sx + 3）的地面都空着
            let turnFree = true;
            for (let x = x0 + 1; x !== sx + 3 + st; x += st) {
              if (!cellFree(x, py)) {
                turnFree = false;
                break;
              }
            }
            const dir = Math.sign(s.y - py);
            if (turnFree && cellFree(col, py) && (!dir || cellFree(col, py + dir))) {
              ok = true;
              break;
            }
          }
          nv++;
        }
        if (!ok) {
          orphan(leg);
          continue;
        }
        prev = py;
        // 原来的 assign(leg, slot, py, stub)
        record(leg, k, slot, py, x0, sy, up, nv);
        use(x0, sy + 2 * up);
        use(x0, sy + 3 * up);
        let y = start;
        for (let j = 0; j < nv; j++, y += up) use(x0, y);
        use(x0, py);
        let nt = 0;
        for (let x = x0 + 1; x !== sx + 3 + st; x += st, nt++) use(x, py);
        use(col, py);
        const pd = Math.sign(s.y - py);
        if (pd) use(col, py + pd);
        cost += nv + 3 + nt + Math.abs(py - yOf(leg)) * 3; // 原来 stub.length + …（长度是整数，先加哪几项都一样）
      }
    };
    /**
     * 给定分组和站位（centers 的前 nc 项），给每条带分配站口；方案写进 out，返回代价（不改动别的状态）。
     * 每座站：离站心 3 行以内的带优先用右侧 3 个口；在站上方的用上侧车道，下方的用下侧车道（各 3 条）。
     * 车道沿站列竖直走到目标行（被占就再往外挪），右拐接到走廊。分不到口的带记为 orphan，代价 1000。
     */
    // lss：每组的带（groups 不变时各个站位共用，不用每次重新摊平）。
    // 代价只增不减（每一项都 ≥ 0，分不到口的最后每条再加 1000）：排完一座站时已经不比 bound 便宜，就不可能被选上，直接返回 null
    const tryPlan = (groups, lss, centers, nc, bound, out) => {
      T = out;
      T.n = 0;
      T.nOrph = 0;
      ust = ++usedStamp;
      farUsed = null;
      for (let q = 0; q < nc; q++) {
        const sy = centers[q];
        for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) use(sx + dx, sy + dy);
      }
      cost = groups.length * 20; // 每座站本身也有代价，不随便多放
      for (let k = 0; k < groups.length; k++) {
        const sy = centers[k];
        const ls = lss[k];
        // 分池：近的进右侧，远的按上下进车道；某个池满了，多出来的依次挪到右侧、对面车道，再不行就是 orphan
        // near：离站心 3 行以内的，按离站心的远近（原来 filter 再 sort((a, b) => |yOf(a) − sy| − |yOf(b) − sy|)）；right 是它的前 3 条
        let nn = 0;
        for (let i = 0; i < ls.length; i++) {
          const l = ls[i];
          if (Math.abs(yOf(l) - sy) <= 3) NEAR[nn++] = l;
        }
        for (let i = 1; i < nn; i++) {
          const l = NEAR[i];
          let j = i - 1;
          while (j >= 0 && Math.abs(yOf(NEAR[j]) - sy) - Math.abs(yOf(l) - sy) > 0) {
            NEAR[j + 1] = NEAR[j];
            j--;
          }
          NEAR[j + 1] = l;
        }
        let nr = nn < 3 ? nn : 3;
        for (let i = 0; i < nr; i++) RIGHT[i] = NEAR[i];
        // ups：不在 right 里、在站心或以上的，远的在前（sort((a, b) => yOf(b) − yOf(a))）；downs：在站心以下的（sort((a, b) => yOf(a) − yOf(b))）。
        // 原来是两遍 filter，两个条件互斥，一遍分开先后一样
        let nu = 0;
        let nd = 0;
        for (let i = 0; i < ls.length; i++) {
          const l = ls[i];
          let inRight = false;
          for (let q = 0; q < nr && !inRight; q++) inRight = RIGHT[q] === l;
          if (inRight) continue;
          if (yOf(l) >= sy) {
            let j = nu - 1;
            while (j >= 0 && yOf(l) - yOf(UPS[j]) > 0) {
              UPS[j + 1] = UPS[j];
              j--;
            }
            UPS[j + 1] = l;
            nu++;
          } else if (yOf(l) < sy) {
            let j = nd - 1;
            while (j >= 0 && yOf(DOWNS[j]) - yOf(l) > 0) {
              DOWNS[j + 1] = DOWNS[j];
              j--;
            }
            DOWNS[j + 1] = l;
            nd++;
          }
        }
        // spill：ups 第 3 条以后的，接着 downs 第 3 条以后的
        let ns = 0;
        for (let i = 3; i < nu; i++) SPILL[ns++] = UPS[i];
        for (let i = 3; i < nd; i++) SPILL[ns++] = DOWNS[i];
        if (nu > 3) nu = 3;
        if (nd > 3) nd = 3;
        for (let i = 0; i < ns; i++) {
          const l = SPILL[i];
          if (nr < 3) RIGHT[nr++] = l;
          else if (nu < 3) UPS[nu++] = l;
          else if (nd < 3) DOWNS[nd++] = l;
          else orphan(l);
        }
        lanes(UPS, nu, 1, sy, k);
        lanes(DOWNS, nd, -1, sy, k);
        // 右侧 3 个口：按目标行从低到高试下中上的排列，出入口格被占了就换（原来 rest = right.sort((a, b) => yOf(a) − yOf(b))）
        for (let i = 1; i < nr; i++) {
          const l = RIGHT[i];
          let j = i - 1;
          while (j >= 0 && yOf(RIGHT[j]) - yOf(l) > 0) {
            RIGHT[j + 1] = RIGHT[j];
            j--;
          }
          RIGHT[j + 1] = l;
        }
        // 最好的排列是第 bq 种、代价 bc（原来的 best = {dys, c}，没有时 bq 为 −1）
        const perms = RIGHT_DYS[nr];
        let bq = -1;
        let bc = 0;
        for (let q = 0; q < perms.length; q++) {
          const dys = perms[q];
          let cc = 0;
          let ok = true;
          for (let i = 0; i < nr; i++) {
            const leg = RIGHT[i];
            const py = sy + dys[i];
            const s = segOf(leg);
            if (s.y === py && pathFree(leg, s) && cellFree(col, py)) continue;
            if (!cellFree(col, py)) ok = false;
            const dir = Math.sign(s.y - py);
            if (dir && !cellFree(col, py + dir) && !dys.includes(dys[i] + dir)) ok = false;
            // 走廊里口的下一格是另一个站口时，只能在口上一边转弯一边升起（难看），尽量换个排列
            if (dir && dys.includes(dys[i] + dir)) cc += 30;
            cc += Math.abs(py - s.y) * 3 + (dys[i] === 0 ? 2 : 0);
          }
          if (!ok) cc += 1000;
          if (bq < 0 || cc < bc) {
            bq = q;
            bc = cc;
          }
        }
        if (bq >= 0 && bc >= 1000) {
          cost += 1000;
          for (let i = 0; i < nr; i++) orphan(RIGHT[i]);
        } else if (bq >= 0) {
          const dys = perms[bq];
          for (let i = 0; i < nr; i++) {
            const leg = RIGHT[i];
            const dy = dys[i];
            const py = sy + dy;
            record(leg, k, RIGHT_SLOT[dy], py, 0, 0, 0, 0);
            use(col, py);
            cost += 2 + Math.abs(py - yOf(leg)) * 3;
          }
          // 原来是 for (const p of plan.slice(-rest.length))：右侧口有几条就是刚记的那几条。没有右侧口时 slice(-0) 是整个方案，
          // 把之前每条的 use(col, py + dir) 再标一遍：那些格加入时都已经用这个戳标过（车道在 assign 里同样的 segOf(leg).y 和 py，
          // 右侧口在各自那座站的这一圈里），同一个戳重复标不改任何东西（usedBuf 原值、farUsed 的 Set 已经有），所以不用再标
          for (let e = T.n - nr; e < T.n; e++) {
            const dir = Math.sign(segOf(T.leg[e]).y - T.py[e]);
            if (dir) use(col, T.py[e] + dir);
          }
        }
        if (cost + T.nOrph * 1000 >= bound) return null;
      }
      cost += T.nOrph * 1000;
      return cost;
    };
    // 选中的方案（PLANS 里的一份，没有时 null）；备用的那份给下一次试算写。选上时两份对调，选中那份的站位另抄一份（试算的站位缓冲还要接着用）
    let chosen = null;
    let spare = PLANS[0];
    const seen = new Set();
    for (let ci = 0; ci < CAPS.length; ci++) {
      const cap = CAPS[ci];
      const groups = groupBy(cap);
      const sig = groups.map((g) => g.length).join(',');
      if (seen.has(sig)) continue; // 同样的分法不用再试
      seen.add(sig);
      const need = groups.length * PITCH - 1;
      if (need > height) {
        if (chosen) continue; // 只有最少站数的方案才值得为它加高
        height = need;
      }
      // 站位：在对准各组平均行的基础上整体上下平移，平移到顶到底为止。每组的带和平均行和平移无关，先算好
      const lss = groups.map((g) => g.flatMap((it) => it.legs));
      const mid = lss.map((ls) => Math.round(ls.reduce((a, l) => a + yOf(l), 0) / ls.length));
      const nc = mid.length;
      // 平移越大，每座站的中心行都不减（centersFor 里只有取大、取小），所以同样的站位总是连成一段：
      // 和上一个比就能去重（以前用 Set 记下全部站位的字符串，结果一样，NaN 也当相同）。当前写进不是 prev 的那份
      let prev = null;
      for (let shift = -height; shift <= height; shift++) {
        const centers = prev === CEN_A ? CEN_B : CEN_A;
        centersFor(mid, shift, centers);
        if (prev !== null && sameCenters(centers, prev, nc)) continue;
        prev = centers;
        const p = tryPlan(groups, lss, centers, nc, chosen ? chosen.cost : Infinity, spare);
        if (p !== null && (!chosen || p < chosen.cost)) {
          const was = chosen;
          chosen = spare;
          spare = was ?? PLANS[1];
          chosen.cost = p;
          chosen.groups = groups;
          for (let k = 0; k < nc; k++) chosen.cen[k] = centers[k];
        }
      }
      if (!chosen.nOrph && chosen.cost < 1000) break; // 最少站数已经全接上，不再加站
    }
    if (chosen.nOrph) addPenalty('route', P.route * chosen.nOrph, `物流站的站口不够用（${chosen.nOrph} 条带没接上站）`);
    chosen.groups.forEach((g, k) => {
      const st = { x: sx, y: chosen.cen[k], items: [...g.map((it) => ({ itemId: it.itemId, role: it.role })), ], ports: [] };
      stations.push(st);
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) putGround(st.x + dx, st.y + dy);
    });
    const STUB = list(16);
    for (let e = 0; e < chosen.n; e++) {
      const leg = chosen.leg[e];
      const k = chosen.k[e];
      const slot = chosen.slot[e];
      const py = chosen.py[e];
      const s = segOf(leg);
      leg.edge = col;
      leg.py = py;
      leg.station = { k, slot };
      // stub：按原来的格子、先后建 [x, y, 0]（原来 stub.map(([x, yy]) => [x, yy, 0])），先写进共用数组再切一份刚好长度的
      const up = chosen.up[e];
      let ns = 0;
      if (up === 0) {
        STUB[ns++] = [sx + 2, py, 0];
        STUB[ns++] = [sx + 3, py, 0];
      } else {
        const x0 = chosen.x0[e];
        const sy = chosen.sy[e];
        STUB[ns++] = [x0, sy + 2 * up, 0];
        STUB[ns++] = [x0, sy + 3 * up, 0];
        let y = sy + 4 * up;
        for (let j = 0; j < chosen.nv[e]; j++, y += up) STUB[ns++] = [x0, y, 0];
        STUB[ns++] = [x0, py, 0];
        const st = sx + 3 >= x0 + 1 ? 1 : -1;
        for (let x = x0 + 1; x !== sx + 3 + st; x += st) STUB[ns++] = [x, py, 0];
      }
      leg.stub = STUB.slice(0, ns);
      for (let j = 0; j < ns; j++) putGround(STUB[j][0], STUB[j][1]);
      if (s.y === py && groundTo(leg, s, col)) leg.direct = true;
      else {
        putGround(col, py);
        const dir = Math.sign(s.y - py);
        if (dir) putGround(col, py + dir);
      }
      stations[k].ports.push({ slot, leg: leg.id, itemId: leg.itemId, dir: leg.kind === 'in' ? 'out' : 'in' });
      ports.push({ kind: leg.kind, itemId: leg.itemId, x: col, y: py, rate: leg.rate, leg: leg.id, direct: !!leg.direct, station: k, slot });
    }
    // 实在分不到站口的带：退回成走廊上的普通出入口（已经按不可行重罚，这里只保证几何能生成）
    for (let e = 0; e < chosen.nOrph; e++) {
      const leg = chosen.orph[e];
      const s = segOf(leg);
      leg.edge = col;
      leg.py = portY(col, s.y);
      putGround(col, leg.py);
      if (leg.py !== s.y) putGround(col, leg.py + Math.sign(s.y - leg.py));
      ports.push({ kind: leg.kind, itemId: leg.itemId, x: col, y: leg.py, rate: leg.rate, leg: leg.id, direct: false });
    }
  }
}
