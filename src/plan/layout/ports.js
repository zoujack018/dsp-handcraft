// 出入口：紧凑布局接到左右边缘；物流站靠左侧时排站、分站口和车道
import { STATION_SIZE, gk, keepFreeSlot, line, permutations, stationItemCap } from './shared.js';
import { STATION_GAP, realItem } from '../../gamedata.js';

// 地面占用表的缓冲区按线程复用（和 elevation.js 的归属表一样）：每次 placePorts 换一个代际，代际不同就当空着，不用清零。
// usedBuf 是站口方案（tryPlan）试算时已占的地面格，同样大小、同样编号，每试一个方案换一个戳
let groundBuf = new Int32Array(0);
let usedBuf = new Int32Array(0);
let groundGen = 0;
let usedStamp = 0;
function groundGrid(size) {
  // 一次 placePorts 最多试 3 × (2 × 高度 + 1) 个方案，戳离上限留足余量
  if (groundBuf.length < size || groundGen >= 1e9 || usedStamp >= 1e9) {
    const n = Math.max(size, Math.ceil(groundBuf.length * 1.5));
    groundBuf = new Int32Array(n);
    usedBuf = new Int32Array(n);
    groundGen = 0;
    usedStamp = 0;
  }
  groundGen++;
  return { buf: groundBuf, gen: groundGen };
}

/** 右侧 3 个站口按目标行从低到高试的下中上排列：带数 n（0~3）→ 排列表（只读，各次共用） */
const RIGHT_DYS = [0, 1, 2, 3].map((n) => permutations([-1, 0, 1]).map((p) => p.slice(0, n)));
/** 右侧站口：上中下 → 11/10/9 号口 */
const RIGHT_SLOT = { 1: 11, 0: 10, [-1]: 9 };
/** 同一列相邻两站的中心至少隔 STATION_GAP（取整到 24 行，游戏规则） */
const PITCH = Math.max(STATION_SIZE + 1, Math.ceil(STATION_GAP));

/** route() 的一步：读写共享的布局上下文 c */
export function placePorts(c) {
  const { P, addPenalty, atPort, corridor, legs, opt, segments, side, stationX, xR } = c;
  let { height } = c; // 物流站靠左侧时，站叠起来比生产区高，要把布局加高
  // ---------- E. 高架段与出入口 ----------
  // 地面上已占用的带子格：按 (x, y) 编成一维下标的 Int32Array（代替数字键的 Set，退火里每次 route() 都要把所有段的格子记一遍）。
  // 表按布局四周各留 GM 格；物流站靠左侧时站叠起来可能比生产区高，按最多的站数留够高度。万一超出表的范围，退回 Set，结果和原来一样
  const GM = 16;
  const GW = xR + 2 + 2 * GM;
  const GH = (side ? Math.max(height, (legs.length + 2) * PITCH) : height) + 2 * GM;
  const gg = groundGrid(GW * GH);
  const G = gg.buf;
  const gen = gg.gen;
  const far = new Set();
  const onGround = (x, yy) => {
    const gx = x + GM;
    const gy = yy + GM;
    return gx >= 0 && gy >= 0 && gx < GW && gy < GH ? G[gx * GH + gy] === gen : far.has(gk(x, yy));
  };
  const putGround = (x, yy) => {
    const gx = x + GM;
    const gy = yy + GM;
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) G[gx * GH + gy] = gen;
    else far.add(gk(x, yy));
  };
  for (const s of segments) for (let x = s.a; x <= s.b; x++) putGround(x, s.y);
  const ports = [];
  /** 边缘列上找一个地面空格做出入口，优先与段同一行 */
  const portY = (xe, y0) => {
    // 同一行最好；其次隔 2 行以上（斜坡升到高处先直走再拐）；隔 1 行时斜坡顶就是拐角，放最后
    // 出入口这一格和它竖直方向上斜坡顶那一格的地面都要空着
    const ok = (yy) => {
      if (yy < 0 || yy >= height) return false;
      const up = yy === y0 ? null : yy + Math.sign(y0 - yy);
      return !onGround(xe, yy) && (up === null || !onGround(xe, up));
    };
    if (ok(y0)) return y0;
    for (let dy = 2; dy <= height + 1; dy++) {
      if (ok(y0 - dy)) return y0 - dy;
      if (ok(y0 + dy)) return y0 + dy;
    }
    if (ok(y0 - 1)) return y0 - 1;
    if (ok(y0 + 1)) return y0 + 1;
    return y0;
  };
  /** endX + d 到 col（含两端）这一行地面是否都空着 */
  const rowFree = (endX, d, col, y) => {
    const step = col >= endX + d ? 1 : -1;
    for (let x = endX + d; x !== col + step; x += step) if (onGround(x, y)) return false;
    return true;
  };
  /** 把段的端头沿地面一直接到 col（这一行地面都空着时），返回是否接上了 */
  const groundTo = (leg, s, col) => {
    let endX = leg.kind === 'in' ? s.entryX : s.exitX;
    const d = leg.kind === 'in' ? -s.dir : s.dout;
    if (atPort(endX, col)) return true;
    if ((col - endX) * d <= 0) return false;
    if (!rowFree(endX, d, col, s.y)) return false;
    for (const x of line(endX + d, col)) putGround(x, s.y);
    if (d > 0) s.b = col;
    else s.a = col;
    if (leg.kind === 'in') s.entryX = col;
    else s.exitX = col;
    return true;
  };
  const stations = []; // 物流站：{x, y, items: [{itemId, role}], ports: [{slot, legId}]}
  if (!side) {
    for (const leg of legs) {
      if (leg.kind === 'link') continue;
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
  } else {
    // ---------- E1. 物流站靠左侧 ----------
    // 站在最左侧 7 列（中心 x=3），第 7 列是主干走廊，生产区从第 8 列开始。站口：
    //   右侧 11/10/9 号口（中心 +2，上中下）经 +3 接到走廊；
    //   上侧 0/1/2 号口（中心 +2 行，右中左）各引一条地面车道沿站列往上，到目标行右拐接到走廊；
    //   下侧 8/7/6 号口同样往下（上下侧的口号是按逆时针编号推断的，待实测）。
    // 车道右拐不能互相交叉：往上的车道里最靠右的服务最低的行，往左依次更高；往下的同理。
    // 左侧的口朝着蓝图外面，不用。
    const io = legs.filter((l) => l.kind !== 'link');
    const yOf = (l) => segments[l.kind === 'in' ? l.to : l.from].y;
    const segOf = (l) => segments[l.kind === 'in' ? l.to : l.from];
    // 按真实物品分：副产物送出去的带和产线自己要用的同种物品共用一个存储格，送出的多就设为供应
    const byItem = new Map();
    for (const l of io) (byItem.get(realItem(l.itemId)) || byItem.set(realItem(l.itemId), []).get(realItem(l.itemId))).push(l);
    const roleOf = (ls) => (ls.some((l) => l.kind === 'out') && ls.reduce((a, l) => a + (l.kind === 'out' ? 1 : -1) * (l.rate ?? 0), 0) >= 0 ? 'supply' : 'demand');
    const items = [...byItem.entries()]
      .map(([itemId, ls]) => ({ itemId, legs: ls, y: ls.reduce((a, l) => a + yOf(l), 0) / ls.length, role: roleOf(ls) }))
      .sort((a, b) => a.y - b.y);
    const col = corridor;
    const sx = stationX;
    const pathFree = (leg, s) => {
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
      for (const it of items) {
        for (let i = 0; i < it.legs.length; i += 9) {
          const part = { ...it, legs: it.legs.slice(i, i + 9) };
          if (!cur || cur.length >= kinds || n + part.legs.length > cap) {
            groups.push((cur = []));
            n = 0;
          }
          cur.push(part);
          n += part.legs.length;
        }
      }
      return keepFreeSlot(groups, slots); // 喷增产剂时至少留一个空格给增产剂
    };
    /** 每座站的中心行：尽量对准它那组带的平均行（mid：取整后的平均行，和平移无关，调用方先算好），相邻两站至少隔 PITCH（中间留出车道拐弯的空行） */
    const centersFor = (mid, shift) => {
      const c = mid.map((m) => m + shift);
      const fwd = () => c.forEach((v, k) => (c[k] = Math.max(v, 3, k ? c[k - 1] + PITCH : -Infinity)));
      fwd();
      for (let k = c.length - 1; k >= 0; k--) c[k] = Math.min(c[k], height - 4, k < c.length - 1 ? c[k + 1] - PITCH : Infinity);
      fwd();
      return c;
    };
    /**
     * 给定分组和站位，给每条带分配站口；返回方案和代价（不改动任何状态）。
     * 每座站：离站心 3 行以内的带优先用右侧 3 个口；在站上方的用上侧车道，下方的用下侧车道（各 3 条）。
     * 车道沿站列竖直走到目标行（被占就再往外挪），右拐接到走廊。分不到口的带记为 orphan，代价 1000。
     */
    // lss：每组的带（groups 不变时各个站位共用，不用每次重新摊平）。
    // 代价只增不减（每一项都 ≥ 0，分不到口的最后每条再加 1000）：排完一座站时已经不比 bound 便宜，就不可能被选上，直接返回 null
    const tryPlan = (groups, lss, centers, bound) => {
      // 方案里已占用的地面格（先把所有站体占上，车道不能穿过别的站）：记在 usedBuf 里，这个方案一个戳；表外的格子退回 Set
      const U = usedBuf;
      const ust = ++usedStamp;
      let farUsed = null;
      const use = (x, yy) => {
        const gx = x + GM;
        const gy = yy + GM;
        if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) U[gx * GH + gy] = ust;
        else (farUsed ??= new Set()).add(gk(x, yy));
      };
      const isUsed = (x, yy) => {
        const gx = x + GM;
        const gy = yy + GM;
        return gx >= 0 && gy >= 0 && gx < GW && gy < GH ? U[gx * GH + gy] === ust : farUsed !== null && farUsed.has(gk(x, yy));
      };
      for (const sy of centers) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) use(sx + dx, sy + dy);
      const plan = [];
      const orphans = [];
      let cost = groups.length * 20; // 每座站本身也有代价，不随便多放
      const cellFree = (x, yy) => yy >= 0 && yy < height && !onGround(x, yy) && !isUsed(x, yy);
      for (let k = 0; k < groups.length; k++) {
        const sy = centers[k];
        const ls = lss[k];
        const assign = (leg, slot, py, stub) => {
          plan.push({ leg, k, slot, py, stub });
          for (const c of stub) use(c[0], c[1]);
          use(col, py);
          const s = segOf(leg);
          const dir = Math.sign(s.y - py);
          if (dir) use(col, py + dir);
          cost += stub.length + Math.abs(py - yOf(leg)) * 3;
        };
        // 分池：近的进右侧，远的按上下进车道；某个池满了，多出来的依次挪到右侧、对面车道，再不行就是 orphan
        const near = ls.filter((l) => Math.abs(yOf(l) - sy) <= 3).sort((a, b) => Math.abs(yOf(a) - sy) - Math.abs(yOf(b) - sy));
        const right = near.slice(0, 3);
        let ups = ls.filter((l) => !right.includes(l) && yOf(l) >= sy).sort((a, b) => yOf(b) - yOf(a)); // 远的在前
        let downs = ls.filter((l) => !right.includes(l) && yOf(l) < sy).sort((a, b) => yOf(a) - yOf(b));
        const spill = [...ups.slice(3), ...downs.slice(3)];
        ups = ups.slice(0, 3);
        downs = downs.slice(0, 3);
        for (const l of spill) {
          if (right.length < 3) right.push(l);
          else if (ups.length < 3) ups.push(l);
          else if (downs.length < 3) downs.push(l);
          else orphans.push(l);
        }
        // 车道：up=1 往上（0/1/2 号口），up=-1 往下（8/7/6 号口）。离站近的车道用最靠右的口，拐弯不交叉
        const lanes = (pool, up) => {
          pool.sort((a, b) => (yOf(a) - yOf(b)) * up);
          let prev = up > 0 ? -Infinity : Infinity;
          pool.forEach((leg, i) => {
            const dx = 1 - i;
            const slot = up > 0 ? [0, 1, 2][i] : [8, 7, 6][i];
            const s = segOf(leg);
            const x0 = sx + dx;
            const start = sy + 4 * up; // 出了站体的第一格
            const want = up > 0 ? Math.max(yOf(leg), start, prev + 1) : Math.min(yOf(leg), start, prev - 1);
            const vert = [
              [x0, sy + 2 * up],
              [x0, sy + 3 * up],
            ];
            let py = start;
            let ok = false;
            for (; py >= 0 && py < height; py += up) {
              if (!cellFree(x0, py)) break; // 竖直车道被挡住，再往外也过不去
              if ((py - want) * up >= 0) {
                // 右拐那一段（x0 + 1 到 sx + 3）的地面都空着
                let turnFree = true;
                const st = sx + 3 >= x0 + 1 ? 1 : -1;
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
              vert.push([x0, py]);
            }
            if (!ok) {
              orphans.push(leg);
              return;
            }
            prev = py;
            assign(leg, slot, py, [...vert, [x0, py], ...line(x0 + 1, sx + 3).map((x) => [x, py])]);
          });
        };
        lanes(ups, 1);
        lanes(downs, -1);
        // 右侧 3 个口：按目标行从低到高试下中上的排列，出入口格被占了就换
        const rest = right.sort((a, b) => yOf(a) - yOf(b));
        let best = null;
        for (const dys of RIGHT_DYS[rest.length]) {
          let c = 0;
          let ok = true;
          rest.forEach((leg, i) => {
            const py = sy + dys[i];
            const s = segOf(leg);
            if (s.y === py && pathFree(leg, s) && cellFree(col, py)) return;
            if (!cellFree(col, py)) ok = false;
            const dir = Math.sign(s.y - py);
            if (dir && !cellFree(col, py + dir) && !dys.includes(dys[i] + dir)) ok = false;
            // 走廊里口的下一格是另一个站口时，只能在口上一边转弯一边升起（难看），尽量换个排列
            if (dir && dys.includes(dys[i] + dir)) c += 30;
            c += Math.abs(py - s.y) * 3 + (dys[i] === 0 ? 2 : 0);
          });
          if (!ok) c += 1000;
          if (!best || c < best.c) best = { dys, c };
        }
        if (best && best.c >= 1000) {
          cost += 1000;
          orphans.push(...rest);
        } else if (best) {
          rest.forEach((leg, i) => {
            const dy = best.dys[i];
            const py = sy + dy;
            plan.push({ leg, k, slot: RIGHT_SLOT[dy], py, stub: [[sx + 2, py], [sx + 3, py]] });
            use(col, py);
            cost += 2 + Math.abs(py - yOf(leg)) * 3;
          });
          for (const p of plan.slice(-rest.length)) {
            const dir = Math.sign(segOf(p.leg).y - p.py);
            if (dir) use(col, p.py + dir);
          }
        }
        if (cost + orphans.length * 1000 >= bound) return null;
      }
      cost += orphans.length * 1000;
      return { plan, orphans, cost, groups, centers };
    };
    let chosen = null;
    const seen = new Set();
    for (const cap of [9, 6, 4]) {
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
      // 平移越大，每座站的中心行都不减（centersFor 里只有取大、取小），所以同样的站位总是连成一段：
      // 和上一个比就能去重（以前用 Set 记下全部站位的字符串，结果一样，NaN 也当相同）
      let prev = null;
      for (let shift = -height; shift <= height; shift++) {
        const centers = centersFor(mid, shift);
        if (prev && centers.every((v, k) => v === prev[k] || (v !== v && prev[k] !== prev[k]))) continue;
        prev = centers;
        const p = tryPlan(groups, lss, centers, chosen ? chosen.cost : Infinity);
        if (p && (!chosen || p.cost < chosen.cost)) chosen = p;
      }
      if (!chosen.orphans.length && chosen.cost < 1000) break; // 最少站数已经全接上，不再加站
    }
    if (chosen.orphans.length) addPenalty('route', P.route * chosen.orphans.length, `物流站的站口不够用（${chosen.orphans.length} 条带没接上站）`);
    chosen.groups.forEach((g, k) => {
      const st = { x: sx, y: chosen.centers[k], items: [...g.map((it) => ({ itemId: it.itemId, role: it.role })), ], ports: [] };
      stations.push(st);
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) putGround(st.x + dx, st.y + dy);
    });
    for (const { leg, k, slot, py, stub } of chosen.plan) {
      const s = segOf(leg);
      leg.edge = col;
      leg.py = py;
      leg.station = { k, slot };
      leg.stub = stub.map(([x, yy]) => [x, yy, 0]);
      for (const [x, yy] of stub) putGround(x, yy);
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
    for (const leg of chosen.orphans) {
      const s = segOf(leg);
      leg.edge = col;
      leg.py = portY(col, s.y);
      putGround(col, leg.py);
      if (leg.py !== s.y) putGround(col, leg.py + Math.sign(s.y - leg.py));
      ports.push({ kind: leg.kind, itemId: leg.itemId, x: col, y: leg.py, rate: leg.rate, leg: leg.id, direct: false });
    }
  }
  Object.assign(c, { ports, stations, height });
}
