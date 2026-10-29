// 后处理重走（routeOptions.reroute，默认关；传送带交叉重做第 2、3 步，设计见 out/demo-analysis/设计.md，用户 2026/10/28）：
// 落地、翘曲器带、喷涂机、增产剂带、集装机都照旧放完以后、放供电之前（plan/index.js 的 finishTail），工厂、分拣器、地面段、站、
// 喷涂机、集装机、增产剂带都不动，把每条带上两个固定格之间的那几截（段与段之间的高架、站的接线、出入口的接线、翘曲器带）拆了重走。
// 默认只重走最后挑中的那张，哪一项都不比原来差才换上（plan/index.js 的 planFrame 最后，守门是这里的 rerouteWorse）。
//
// 每截在（格、高度档 h、朝向）上做 A*：h = 0 地面、1 半层、2 第 1 层……（z = h / 2，docs/game-rules.md 第 38 条）。代价（越小越好）：
//   水平走一格 1 + a[h′]；高度变一档 tau，一格变两档是陡坡（要超级磁场）另加 steep；拐弯 turn（拐进终点那格也算），变高的那一步同时拐弯另加 slopeTurn；
//   原地竖直升降（同一格里每节差一层，官方垂直传送带）允许但最贵：每层 2·tau + lift，外加那一节带子，只在直行的格子里做——
//   所以坡越缓越便宜：每格半层 < 每格一层的陡坡 < 原地竖直（用户 2026/10/28）；
//   走进有别的链的格（叠格）另加 over，从没有别的链的格走进去（相遇）再加 meet；
//   外框：走出固定的东西加原来的接线围成的框，每往外撑一列（行）按那一边的长度 × exit，框外每格另加 outer；
//   最外一圈（固定的东西围成的框以外）每格另加 ring，翘曲器带在固定的东西围成的框以外每格另加 ringWarper（往里收，外框能小一点）。
//   不用原地升降（route.js 的 noLift）时一格最多变一档、不原地升降、不出陡坡；接卫星配电站时新路不上 4 层以上（顶盘在 4.18~5.27 层，供电后放）。
// 挡路：工厂、物流站、喷涂机和集装机的机身、先选好的供电设施位（所有高度）；分拣器手臂那几格的地面和半层、分拣器接的那格的半层
//   （半层不压分拣器，硬规则；手臂底下的地面是保守，这一截原来就走在那儿的照旧能走）；喷涂空当的保护区；边缘出入口往外那一行的地面；
//   别的带子占着的（格、档）和原地升降那一叠的中间几档；同一条边（同样两格之间）上挨着走的两条带上下不能对调（半路交叉）。
// 固定格：地面段（裁段 trim：段两头超出首尾分拣器的那几格并进接着它的那截一起重走）、站口和站身边那格、边缘出入口那格；
//   经过集装机（和前后各一格）、喷涂机（和前后各两格）的截整截不动；侧边总线、桥、喷涂窗口、接仓、接发电厂的截也不动。
// 排法：按原来的长度长的先排，一截截拆了重走，整体重排 passes 遍（哪一遍谁都没变就停）；每截先在两层（地面 / 空中）的放宽图上倒着算一遍
//   到终点的代价下限当启发值（buildMap），第二遍起只算代价不超过上一遍那条 1.1 倍加 5 的椭圆；某一截找不到路（或出堆超过 budget）
//   就留着原来那条（原来那条的格子一直空着，不冲突），后面几遍不再找。
// 物流站的原料接线（resource）：可以从任意一座已存这种原料、或还有空格的站的空口出（一座站最多 5 种，增产剂的空格照留，
//   同一种物品的供应和需求不进同一座站，docs/game-rules.md 第 37 条；离开的那座站不能空掉）；只有一段、全是取料口的原料带（flip）
//   可以接段尾、整段掉头流（同 stations.js；喷涂机所在的链不翻）。
// 供电：重走前先在布局上选一组设施位（新路让开），放供电时现选的要往外加地，而这一组原样还能用，就用这一组（L.powerReserve）。
import { chainTiles } from '../emit/blueprint.js';
import { sprayGuards } from './layout/elevation.js';
import { portRays, STATION_SLOTS } from './layout/shared.js';
import { STATION_PORTS, cropToContent } from './stations.js';
import { placePower } from './power.js';
import { powerCells, realItem, SUBSTATION_DISK } from '../gamedata.js';

/**
 * 代价和开关（routeOptions.reroute 为 true 时用这些；写成对象的按它覆盖，考卷的 ro.rrTau=2 这种也认，见 rerouteOptions）。
 * a：每格按高度档另加（第 1 档半层、第 2 档第 1 层……，按示范校的，out/demo-analysis/calib.mjs），超出的每档加 2；
 * tau、steep、lift、turn、slopeTurn、over、meet、outer、ring、ringWarper、exit 见文件开头（2026/10/28 在 44 张图上扫过，out/rr/sweep.mjs）；
 * newSlot：原料接线换到一座还没存这种原料的站（多占一格）另加；passes 拆了重走几遍；maxH 最高几档（12 = 第 6 层）；
 * budget 每次 A* 最多出堆几次（超了这一截留着原来的路）；pad 布局四周多给几格绕路；resource、flip、trim 见文件开头；power 先选供电设施位；
 * mode：'pick'（默认）只重走最后挑中的那张、哪一项都不比原来差才换上（plan/index.js 的 planFrame）；'all' 每个候选都重走、重走后的代价参与挑选；
 * turnGuard（实验开关，默认关，考卷写 ro.rrTurnGuard=1）：守门也比拐弯（拐弯不比原来多才换上），换不上时先把拐弯的代价（turn、slopeTurn）乘 turnMul 再试一次
 * （turnMul 5：2026/10/29 在引力矩阵 30 不用原地升降、考卷 2 快速档上比过 2、3、5 倍，2 倍几乎换不上，3、5 倍差不多，5 倍换上的多一点）
 */
export const REROUTE = { a: [0, 0.8, 0.4, 2, 4], tau: 3, steep: 1.5, lift: 6, turn: 5, slopeTurn: 0.5, over: 1, meet: 2, outer: 2, ring: 0.5, ringWarper: 1, exit: 1, newSlot: 2, passes: 3, maxH: 12, budget: 40000, pad: 4, resource: true, flip: true, power: true, trim: true, mode: 'pick', turnGuard: false, turnMul: 5 };
const KEYS = Object.keys(REROUTE);

/** routeOptions → 重走的参数；没开时 null。ro.reroute 可以是 true 或参数对象，ro.rrXxx（考卷 --trees 名字=.:ro.rrTau=2）也认 */
export function rerouteOptions(ro) {
  if (!ro?.reroute) return null;
  const o = { ...REROUTE, a: REROUTE.a.slice() };
  const src = typeof ro.reroute === 'object' ? ro.reroute : {};
  for (const k of KEYS) {
    const alt = ro[`rr${k[0].toUpperCase()}${k.slice(1)}`];
    const v = src[k] ?? alt;
    if (v == null) continue;
    if (k === 'a') o.a = (Array.isArray(v) ? v : String(v).split(/[+/]/)).map(Number);
    else if (typeof REROUTE[k] === 'boolean') o[k] = v === true || v === 1 || v === '1' || v === 'true';
    else if (typeof REROUTE[k] === 'string') o[k] = String(v);
    else o[k] = Number(v);
  }
  return o;
}

/** 堆按 f 排，f 一样时先出走得远的（g 大的）：同样代价的路很多（地面上曼哈顿距离一样的走法），不这样会把一大片平手的格都出一遍 */
const TIE = 1e-7;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const back = (d) => (d + 2) & 3;
const dirOf = (dx, dy) => (dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : dy < 0 ? 3 : -1);
/** 朝 d 走（-1：还没定）到相对位置 (dx, dy) 至少拐几次弯：正前方 0，前方或两侧 1，身后 2，正后方 3（同 stations.js 的 minTurns） */
function minTurns(d, dx, dy) {
  if (!dx && !dy) return 0;
  if (d < 0) return dx && dy ? 1 : 0;
  const along = dx * DX[d] + dy * DY[d];
  const side = DX[d] ? dy : dx;
  if (along > 0) return side ? 1 : 0;
  if (along === 0) return 1;
  return side ? 2 : 3;
}

// A* 的工作区（按线程复用）：状态 s = ((格 × HN) + 档) × 4 + 朝向
let G = new Float64Array(0);
let PR = new Int32Array(0);
let ST = new Int32Array(0); // G[s] 是这一次写的（戳）
let CL = new Int32Array(0); // 这一次已经出过堆
let LF = new Uint8Array(0); // 进这个状态的那一步先在上一格原地升降过
let stamp = 0;
let hk = new Float64Array(1024);
let hv = new Int32Array(1024);
// 启发值的地图（见 rerouteBelts 里的 buildMap）：每格地面、空中两层到终点的代价下限，按线程复用
let MD = new Float64Array(0);
let MS = new Int32Array(0); // MD 是这一次写的（戳）
let MC = new Int32Array(0); // 这一次已经定了
let WANT = new Int32Array(0); // 起点四周的格（戳）
let mstamp = 0;
let mk = new Float64Array(1024);
let mv = new Int32Array(1024);
function ensureMap(n) {
  if (MD.length >= n && mstamp < 2e9) return;
  const m = Math.max(n, Math.ceil(MD.length * 1.25));
  MD = new Float64Array(m);
  MS = new Int32Array(m);
  MC = new Int32Array(m);
  WANT = new Int32Array(m);
  mstamp = 0;
}
function ensure(n) {
  if (G.length >= n && stamp < 2e9) return;
  const m = Math.max(n, Math.ceil(G.length * 1.25));
  G = new Float64Array(m);
  PR = new Int32Array(m);
  ST = new Int32Array(m);
  CL = new Int32Array(m);
  LF = new Uint8Array(m);
  stamp = 0;
}

/**
 * 带子的格子按链的顺序列出来，同时记下每一截（part）占第几到第几格（chainTiles 的写法逐项照抄，两边列出来的格子一模一样）。
 * 返回 { main, extra, spans: [{ part, i, j }] }，main[i..j) 是这一截的格子
 */
function chainSpans(L, chain) {
  const main = [];
  const spans = [];
  for (const part of chain.parts) {
    const i = main.length;
    if (part.leg != null) {
      const l = L.legs[part.leg];
      if (l.kind === 'in') {
        if (l.stub) main.push(...l.stub);
        if (l.pre) main.push(...l.pre);
        if (!l.direct) main.push([l.edge, l.py, 0]);
        main.push(...l.cells);
      } else if (l.kind === 'out') {
        main.push(...l.cells);
        if (!l.direct) main.push([l.edge, l.py, 0]);
        if (l.stub) main.push(...l.stub.slice().reverse());
      } else main.push(...l.cells);
    } else {
      const s = L.segments[part.seg];
      const run = (a, b) => {
        const st = a <= b ? 1 : -1;
        for (let x = a; st > 0 ? x <= b : x >= b; x += st) main.push([x, s.y, 0]);
      };
      if (s.split == null) {
        if (s.dir > 0) run(s.a, s.b);
        else run(s.b, s.a);
      } else if (s.cont === 'L') {
        if (s.split > s.a) run(s.split - 1, s.a);
      } else if (s.cont === 'R') run(s.split, s.b);
    }
    spans.push({ part, i, j: main.length });
  }
  const { extra } = chainTiles(L, chain);
  return { main, extra, spans };
}

/**
 * 后处理重走：直接改 L（各截的格子、站的接线和存储、翻过来的段），最后裁边、重数带子（cropToContent）。
 * ctx：{ opts（rerouteOptions 的结果）, power, powerOptions, maxWidth, maxHeight, slots（物流站的额外格子：keepFree 留增产剂的空格） }。
 * 结果统计记在 L.reroute：{ nets 截数, kept 留着原来的路的, switched 换了站或口的原料接线, flipped 翻过来的段, pops A* 出堆合计, ms }
 */
export function rerouteBelts(L, { opts = REROUTE, power = null, powerOptions = null, maxWidth = null, maxHeight = null, slots = null } = {}) {
  const t0 = performance.now();
  // 供电设施：先在现在的布局上选好位置（同接站时的预留），新路不占；放下以后真正的供电照旧在后面另放（plan/power.js）。
  // 要在裁段（trim）之前选：裁下来的那几格还算地面段，不然会把塔放到这几格上、这一截就回不去了
  let prePower = null;
  if (power && opts.power) {
    try {
      prePower = placePower(L, power, { ...powerOptions, maxWidth, maxHeight });
      const e = prePower.extend;
      // 没往外加地、全覆盖到的那一组记下来（跟着布局平移），后面放供电时现选的要往外加地，就退回这一组（plan/index.js 的 finishOne）
      if (!prePower.uncovered && !e.left && !e.right && !e.bottom && !e.top) L.powerReserve = { type: power, nodes: prePower.nodes.map(({ x, y }) => ({ x, y })) };
    } catch {
      prePower = null; // 预选失败（不会）：不预留
    }
  }
  const powMs = performance.now() - t0;
  const noLift = !!L.noLift;
  const DMAX = noLift ? 1 : 2;
  // 新路最高到第几档。卫星配电站的顶盘（5.49 格见方、4.18~5.27 层，docs/game-rules.md 第 38 条）在供电放好以前不知道在哪，
  // 接卫星配电站时新路一律不上 4 层以上（第 8 档），免得后放的配电站顶盘撞上（顶盘那一圈以上的 5.5 层也够不着：要从 4.5、5 层过）
  const MAXH = Math.min(opts.maxH, power === 'substation' ? 8 : 14); // 第 7 层以上不走（OVERPASS_ZMAX：用户只确认到第 7 层）
  const stations = L.stations || [];
  const edgeStations = L.stationMode === 'edge';

  // 高得离谱的（第 15 层以上，不会有）：不动（档位用 int32 的位记，最多 30 档）。要在下面裁段之前看，裁了就得写回
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    for (const q of [...t.main, ...t.extra.flat()]) if (q[2] > 14.5) return L;
  }
  for (const w of [...(L.warperLinks || []), ...(L.proLines || [])]) for (const q of w.cells) if (q[2] > 14.5) return L;
  // —— 一、要重走的截 ——
  // 每截：start / goal 两个固定格 [x, y]、出发时的朝向（startDir，-1 不限）、只能直走出去（straight，站口）、
  // 进终点时不能从哪个方向来（goalBad：终点后面链接着走的那格）、原来的格子（old，两头固定格之间的，[x, y, h]）、写回的办法
  const nets = [];
  const fixedTiles = []; // 不重走的带子：每条是一串 [x, y, z]，fixedChain 同一下标记它是哪条链（翘曲器带每条一个号，排在物品链后面）
  const fixedChain = [];
  const pushFixed = (tiles, chain) => {
    fixedTiles.push(tiles);
    fixedChain.push(chain);
  };
  const chainInfo = L.chains.map((ch, ci) => ({ ch, ci, ...chainSpans(L, ch) }));
  const singles = new Set(); // 只有一段的原料带（能翻）
  for (const { ch } of chainInfo) if (ch.parts.length === 2 && ch.parts[0].leg != null && ch.parts[1].seg != null) singles.add(ch.parts[1].seg);
  const H2 = (z) => Math.round(z * 2);
  const lastOther = (tiles, k) => {
    // tiles[k] 之前最后一个不在同一格的（来路），没有时 null
    for (let j = k - 1; j >= 0; j--) if (tiles[j][0] !== tiles[k][0] || tiles[j][1] !== tiles[k][1]) return tiles[j];
    return null;
  };
  const nextOther = (tiles, k) => {
    for (let j = k + 1; j < tiles.length; j++) if (tiles[j][0] !== tiles[k][0] || tiles[j][1] !== tiles[k][1]) return tiles[j];
    return null;
  };
  const dirFromTo = (a, b) => (a && b ? dirOf(Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])) : -1);
  const portOfLeg = new Map(L.ports.map((p) => [p.leg, p]));
  // 每段被分拣器接的列（段两头超出首尾分拣器的那几格，trim 开着时并进接着它的那截一起重走）
  const tapCols = new Map();
  for (const so of L.sorterList) {
    if (!tapCols.has(so.segId)) tapCols.set(so.segId, new Set());
    tapCols.get(so.segId).add(so.col);
  }
  const trimmable = (sg) => sg && sg.split == null && !sg.sprayGap && (sg.dir === 1 || sg.dir === -1) && tapCols.has(sg.id);
  // 自动集装机（plan/addons.js 的 stackPilers，重走在它之后）那一格和顺着带子前后各一格：集装机骑在上面、前后伸进邻格，
  // 这几格不动——哪截带子经过它们就整截留着不重走；段也不裁到它们
  const pin = new Set();
  for (const p of L.pilers || []) for (const k of [-1, 0, 1]) pin.add(`${p.x + k * p.dx},${p.y + k * p.dy}`);
  // 喷涂机（plan/addons.js 的 addAddons，重走在它之后）骑的那格和顺着带子前后各两格（压着的 3 格不能转弯、升降，再往外各一格也要顺着进出，
  // docs/game-rules.md 第 24 条）：同样不动；喷涂机所在的链也不翻（翻过来喷涂机就到了取料口后面）
  const pin3 = new Set();
  const coated = new Set();
  for (const c of L.coaters || []) {
    coated.add(c.chain);
    const dx = Math.sign(c.x - c.ix), dy = Math.sign(c.y - c.iy);
    for (let k = -2; k <= 2; k++) pin3.add(`${c.x + k * dx},${c.y + k * dy},${c.z ?? 0}`);
  }
  const pinned = (t) => (t[2] === 0 && pin.has(`${t[0]},${t[1]}`)) || pin3.has(`${t[0]},${t[1]},${t[2]}`);
  for (const info of chainInfo) {
    const { ch, main, extra, spans } = info;
    const keep = new Uint8Array(main.length).fill(1); // 1：这一格不重走（固定）
    for (let si = 0; si < spans.length; si++) {
      const sp = spans[si];
      const { part, i, j } = sp;
      if (part.leg == null) continue;
      const l = L.legs[part.leg];
      if (l.broken || l.spray || l.bridge || l.store != null || l.burn != null || l.pre) continue;
      if (l.bus != null && !l.stub) continue; // 侧边总线整条留着（几条并排走得整齐）
      if (l.kind === 'in' && l.stub && !edgeStations) continue;
      if (l.kind === 'out' && l.stub && !edgeStations) continue;
      const port = portOfLeg.get(l.id);
      let net = null;
      if (l.kind === 'link') {
        if (i < 1 || j >= main.length) continue;
        const s = main[i - 1];
        const g = main[j];
        net = { type: 'link', leg: l, start: s, startDir: dirFromTo(lastOther(main, i - 1), s), goal: g, goalOut: dirFromTo(g, nextOther(main, j)), old: main.slice(i, j) };
      } else if (l.kind === 'in' && l.stub) {
        if (j >= main.length || j - i < 2) continue;
        const pc = main[i]; // 站口那格（站身里）
        const be = main[i + 1]; // 站身边上那格
        const g = main[j];
        net = { type: 'feed', leg: l, port, start: be, startDir: dirFromTo(pc, be), straight: true, portCell: pc, goal: g, goalOut: dirFromTo(g, nextOther(main, j)), old: main.slice(i + 2, j), station: { ...l.station } };
        // 能翻：只有一段、不喷涂、不劈开、段上全是取料口
        const seg = L.segments[ch.parts[1]?.seg];
        if (singles.has(seg?.id) && ch.parts[1].seg === seg.id && !seg.sprayGap && seg.split == null && seg.taps.every((t) => t.io === 'in') && !coated.has(info.ci)) net.flipSeg = seg;
      } else if (l.kind === 'out' && l.stub) {
        if (i < 1 || j - i < 2) continue;
        const s = main[i - 1];
        const be = main[j - 2];
        const pc = main[j - 1];
        net = { type: 'sink', leg: l, port, start: s, startDir: dirFromTo(lastOther(main, i - 1), s), goal: be, goalOut: dirFromTo(be, pc), portCell: pc, old: main.slice(i, j - 2), station: { ...l.station } };
      } else if (l.kind === 'in' && !l.stub) {
        if (l.direct || j >= main.length) continue;
        const pc = main[i]; // 边缘出入口那格（固定）
        const g = main[j];
        const raySide = port && port.x <= (L.width - 1) / 2 ? -1 : 1;
        net = { type: 'edgeIn', leg: l, port, start: pc, startDir: dirOf(-raySide, 0), goal: g, goalOut: dirFromTo(g, nextOther(main, j)), old: main.slice(i + 1, j) };
      } else if (l.kind === 'out' && !l.stub) {
        if (l.direct || i < 1) continue;
        const s = main[i - 1];
        const pc = main[j - 1];
        const raySide = port && port.x <= (L.width - 1) / 2 ? -1 : 1;
        net = { type: 'edgeOut', leg: l, port, start: s, startDir: dirFromTo(lastOther(main, i - 1), s), goal: pc, goalOut: dirOf(raySide, 0), old: main.slice(i, j - 1) };
      }
      if (!net) continue;
      if (net.old.some(pinned)) continue;
      if (opts.trim) {
        // 起点那头：前一截是地面段、起点是它最后一格，最后一根分拣器之后多出来的几格并进这一截（段裁到最后一根分拣器那列）
        const prev = spans[si - 1];
        const sgA = prev && prev.part.seg != null ? L.segments[prev.part.seg] : null;
        if ((net.type === 'link' || net.type === 'sink' || net.type === 'edgeOut') && trimmable(sgA) && main[prev.j - 1] === net.start) {
          const cols = tapCols.get(sgA.id);
          let k = prev.j - 1;
          while (k > prev.i && !cols.has(main[k][0])) k--;
          if (cols.has(main[k][0]) && k < prev.j - 1 && !main.slice(k + 1, prev.j).some(pinned)) {
            for (let q = k + 1; q < prev.j; q++) keep[q] = 0;
            net.old = [...main.slice(k + 1, prev.j), ...net.old];
            net.start = main[k];
            net.startDir = dirFromTo(lastOther(main, k), main[k]);
            if (sgA.dir > 0) sgA.b = main[k][0];
            else sgA.a = main[k][0];
            sgA.exitX = main[k][0];
          }
        }
        // 终点那头：后一截是地面段、终点是它第一格，第一根分拣器之前多出来的几格并进来（段从第一根分拣器那列起）
        const next = spans[si + 1];
        const sgB = next && next.part.seg != null ? L.segments[next.part.seg] : null;
        if ((net.type === 'link' || net.type === 'feed' || net.type === 'edgeIn') && trimmable(sgB) && main[next.i] === net.goal) {
          const cols = tapCols.get(sgB.id);
          let k = next.i;
          while (k < next.j - 1 && !cols.has(main[k][0])) k++;
          if (cols.has(main[k][0]) && k > next.i && !main.slice(next.i, k).some(pinned)) {
            for (let q = next.i; q < k; q++) keep[q] = 0;
            net.old = [...net.old, ...main.slice(next.i, k)];
            net.goal = main[k];
            net.goalOut = dirFromTo(main[k], nextOther(main, k));
            if (sgB.dir > 0) sgB.a = main[k][0];
            else sgB.b = main[k][0];
            sgB.entryX = main[k][0];
          }
        }
      }
      for (let k = i; k < j; k++) keep[k] = 0;
      // 两头的固定格（站口、站身边那格、出入口格）照旧算固定
      for (let k = i; k < j; k++) {
        const t = main[k];
        if (t === net.portCell || t === net.start || t === net.goal) keep[k] = 1;
      }
      net.chain = ch.ci ?? info.ci;
      net.itemId = ch.itemId;
      net.old = net.old.map(([x, y, z]) => [x, y, H2(z)]);
      nets.push(net);
    }
    // 固定的那几格按原来的顺序分成几串（相邻的才连着，算边用）
    let run = [];
    for (let k = 0; k < main.length; k++) {
      if (keep[k]) run.push(main[k]);
      else if (run.length) {
        pushFixed(run, info.ci);
        run = [];
      }
    }
    if (run.length) pushFixed(run, info.ci);
    for (const t of extra) pushFixed(t, info.ci);
  }
  // 翘曲器带：站口、站身边那格固定，中间重走
  (L.warperLinks || []).forEach((w, wi) => {
    const c = w.cells;
    const chain = L.chains.length + wi;
    if (!edgeStations || c.length < 5) {
      pushFixed(c, chain);
      return;
    }
    nets.push({ type: 'warper', warper: w, chain, start: c[1], startDir: dirFromTo(c[0], c[1]), straight: true, goal: c[c.length - 2], goalOut: dirFromTo(c[c.length - 2], c[c.length - 1]), old: c.slice(2, -2).map(([x, y, z]) => [x, y, H2(z)]), itemId: 1210 });
    pushFixed([c[0], c[1]], chain);
    pushFixed([c[c.length - 2], c[c.length - 1]], chain);
  });
  // 增产剂带（plan/addons.js，重走在它之后）：不动，当固定的让开
  (L.proLines || []).forEach((pl, k) => pushFixed(pl.cells, L.chains.length + (L.warperLinks || []).length + k));
  if (!nets.length) return L;

  // —— 二、网格 ——
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; // 固定的东西围成的外框（outer 从这里往外算）
  const inc = (x, y) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    const cy = L.rowCy[p.row];
    for (const cx of p.centers) {
      inc(Math.ceil(cx - hw), cy - p.g.bodyBelow);
      inc(Math.floor(cx + hw), cy + p.g.bodyAbove);
    }
  }
  for (const st of stations) {
    inc(st.x - 3, st.y - 3);
    inc(st.x + 3, st.y + 3);
  }
  for (const t of fixedTiles) for (const [x, y] of t) inc(x, y);
  for (const b of [...(L.burners || []), ...(L.stores || [])]) {
    inc(b.rect[0], b.rect[1]);
    inc(b.rect[2], b.rect[3]);
  }
  const cx0 = x0, cx1 = x1, cy0 = y0, cy1 = y1;
  // 外框（走出去要撑大的那个框）：固定的东西加上原来的接线，不算翘曲器带——翘曲器带接站时绕到外面撑大的那一圈，重走时算框外，
  // 不然它让出来以后别的接线又占上去，外框缩不回去
  for (const n of nets) if (n.type !== 'warper') for (const [x, y] of n.old) inc(x, y);
  const fx0 = x0, fx1 = x1, fy0 = y0, fy1 = y1;
  for (const n of nets) for (const [x, y] of n.old) inc(x, y);
  const W0 = L.width, H0 = L.height;
  const padX = maxWidth ? Math.max(0, Math.floor((maxWidth - Math.max(W0, x1 - x0 + 1)) / 2)) : opts.pad;
  const padY = maxHeight ? Math.max(0, Math.floor((maxHeight - Math.max(H0, y1 - y0 + 1)) / 2)) : opts.pad;
  const X0 = Math.min(x0, 0) - padX;
  const Y0 = Math.min(y0, 0) - padY;
  const X1 = Math.max(x1, W0 - 1) + padX;
  const Y1 = Math.max(y1, H0 - 1) + padY;
  const GW = X1 - X0 + 1;
  const GH = Y1 - Y0 + 1;
  const NC = GW * GH;
  const HN = Math.max(opts.maxH + 1, 1 + Math.max(0, ...nets.map((n) => Math.max(0, ...n.old.map((t) => t[2]))), ...fixedTiles.flat().map((t) => H2(t[2]))));
  if (HN > 30) throw new Error('重走：带子高到第 15 层以上'); // 进门时已经查过（见「一、要重走的截」前面），走不到这里
  const ALL = 2 ** HN - 1;
  const inb = (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
  const cid = (x, y) => (y - Y0) * GW + (x - X0);
  const AH = new Float64Array(HN);
  for (let h = 0; h < HN; h++) AH[h] = h < opts.a.length ? opts.a[h] : opts.a[opts.a.length - 1] + 2 * (h - opts.a.length + 1);
  const blk = new Int32Array(NC); // 新路不能用的档（位）
  // 分拣器手臂底下：地面、半层不走（半层不压分拣器是硬规则；地面是保守：原来就是自己这条链地面带的格照旧能走，见 search 的 armFree）
  const arm = new Int32Array(NC);
  const occ = new Int32Array(NC); // 已经有带子的档（位）：固定的和已排的
  const outer = new Float64Array(NC);
  // 外框：现在的布局（含原来的接线）以外的格每格另加 outer（走出去要把外框撑大）；布局以内、固定的东西围成的框以外的那一圈
  // 每格另加 ring（「一点钱」：翘曲器带、接线往里收，外框能小一点）
  // 走出布局还要撑大外框：往外每多一列（行）按那一边的长度另加 exit 倍（面积在最终代价里按 1 倍算，见 index.js 的 finalCost），
  // 进格时按这一格在框外第几列（行）比上一格多出来的算（DXO、DYO 是在框外第几列、第几行）
  // 外框最外一圈（固定的东西围成的框以外的那几格）：每截都另加 ring；翘曲器带在布局以内、固定的东西围成的框以外的格都另加 ringWarper（往里收，外框小一点）
  const RING = new Float64Array(NC);
  const RINGW = new Float64Array(NC);
  const DXO = new Int16Array(NC);
  const DYO = new Int16Array(NC);
  for (let y = Y0; y <= Y1; y++)
    for (let x = X0; x <= X1; x++) {
      const c = cid(x, y);
      if (x < fx0 || x > fx1 || y < fy0 || y > fy1) outer[c] = opts.outer;
      else if (x < cx0 || x > cx1 || y < cy0 || y > cy1) {
        RINGW[c] = opts.ringWarper;
        if (x === fx0 || x === fx1 || y === fy0 || y === fy1) RING[c] = opts.ring;
      }
      DXO[c] = x < fx0 ? fx0 - x : x > fx1 ? x - fx1 : 0;
      DYO[c] = y < fy0 ? fy0 - y : y > fy1 ? y - fy1 : 0;
    }
  const exitW = opts.exit * (fy1 - fy0 + 1); // 往左右撑一列
  const exitH = opts.exit * (fx1 - fx0 + 1); // 往上下撑一行
  const exitCost = (c, c2) => (DXO[c2] > DXO[c] ? (DXO[c2] - DXO[c]) * exitW : 0) + (DYO[c2] > DYO[c] ? (DYO[c2] - DYO[c]) * exitH : 0);
  const block = (x, y, m) => {
    if (Number.isInteger(x) && Number.isInteger(y) && inb(x, y)) blk[cid(x, y)] |= m;
  };
  const bits = (lo, hi) => {
    let m = 0;
    for (let h = Math.max(0, lo); h <= Math.min(HN - 1, hi); h++) m |= 1 << h;
    return m;
  };
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    const cy = L.rowCy[p.row];
    for (const cx of p.centers) for (let x = Math.ceil(cx - hw); x <= Math.floor(cx + hw); x++) for (let y = cy - p.g.bodyBelow; y <= cy + p.g.bodyAbove; y++) block(x, y, ALL);
  }
  for (const st of stations) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) block(st.x + dx, st.y + dy, ALL);
  for (const b of [...(L.burners || []), ...(L.stores || [])]) for (let x = b.rect[0]; x <= b.rect[2]; x++) for (let y = b.rect[1]; y <= b.rect[3]; y++) block(x, y, ALL);
  // 分拣器：手臂那几格（工厂边到带子之间）的地面和半层，接的那格的半层（半层不压分拣器）
  for (const s of L.sorterList) {
    const p = L.pos.get(s.bid);
    const edge = L.rowCy[p.row] + (s.side === 'top' ? p.g.edgeAbove : -p.g.edgeBelow);
    const belt = L.segments[s.segId].y;
    for (let y = Math.min(edge, belt) + 1; y < Math.max(edge, belt); y++) if (inb(s.col, y)) arm[cid(s.col, y)] |= 0b11;
    block(s.col, belt, 0b10);
  }
  // 喷涂空当的保护区：候选格到 2.5 层、取料格两侧的地面到 1.5 层；高架上的窗口按那一层上下各半层
  const guards = sprayGuards(L.segments, L.legs);
  for (const [x, y] of guards.guard2) block(x, y, bits(0, 5));
  for (const [x, y] of guards.guard1) block(x, y, bits(0, 3));
  for (const [x, y, z] of guards.guardZ) block(x, y, bits(H2(z) - 1, H2(z) + 1));
  // 边缘出入口往外那一行的地面
  for (const [x, y] of portRays(L)) block(x, y, 1);
  // 喷涂机（两层高，骑在第 z 层的带子上，压着前后各一格）、自动集装机（骑在地面带上，前后伸进邻格）：机身那几格新路不走
  for (const c of L.coaters || []) {
    const dx = Math.sign(c.x - c.ix), dy = Math.sign(c.y - c.iy);
    for (const k of [-1, 0, 1]) block(c.x + k * dx, c.y + k * dy, bits(H2(c.z ?? 0), H2(c.z ?? 0) + 5));
  }
  for (const p of L.pilers || []) for (const k of [-1, 0, 1]) block(p.x + k * p.dx, p.y + k * p.dy, ALL); // 集装机头顶也不走（放的时候就要求头顶没有高架）
  // 限宽、限长：网格外框就是上限（见 padX、padY），不另外挡
  // 供电设施：先在现在的布局上选好位置（同接站时的预留），新路不占；放下以后真正的供电照旧在后面另放（plan/power.js）
  if (prePower) for (const n of prePower.nodes) for (const [x, y] of powerCells(prePower.itemId, n.x, n.y)) block(x, y, ALL);

  // —— 三、占用和边 ——
  // 边：每格往 +x、+y 两条，链表头 EH[2c + 方向]；条目记小格号那头的档、另一头的档、哪一截（-1 固定）、第几版（拆掉一截就换版，旧条目作废）
  const EH = new Int32Array(2 * NC);
  let eNext = new Int32Array(1024);
  let eA = new Int8Array(1024);
  let eB = new Int8Array(1024);
  let eOwn = new Int32Array(1024);
  let eVer = new Int32Array(1024);
  let eTop = 0;
  const ver = new Int32Array(nets.length);
  const growE = () => {
    const g = (a) => {
      const b = new a.constructor(a.length * 2);
      b.set(a);
      return b;
    };
    eNext = g(eNext);
    eA = g(eA);
    eB = g(eB);
    eOwn = g(eOwn);
    eVer = g(eVer);
  };
  // 两格之间那条边的槽：(c, c′) 相邻；flip：c′ 是小格号那头
  let slot = 0;
  let flipE = 0;
  const edgeSlot = (c, c2) => {
    if (c2 === c + 1) {
      slot = 2 * c;
      flipE = 0;
    } else if (c2 === c - 1) {
      slot = 2 * c2;
      flipE = 1;
    } else if (c2 === c + GW) {
      slot = 2 * c + 1;
      flipE = 0;
    } else {
      slot = 2 * c2 + 1;
      flipE = 1;
    }
  };
  const putEdge = (c, h, c2, h2, own) => {
    edgeSlot(c, c2);
    if (eTop === eNext.length) growE();
    eNext[eTop] = EH[slot];
    eA[eTop] = flipE ? h2 : h;
    eB[eTop] = flipE ? h : h2;
    eOwn[eTop] = own;
    eVer[eTop] = own >= 0 ? ver[own] : 0;
    EH[slot] = ++eTop;
  };
  /** 从 (c, h) 走到相邻的 (c2, h2) 时，同一条边上别的带子有没有和它上下对调的 */
  const edgeOk = (c, h, c2, h2) => {
    edgeSlot(c, c2);
    for (let e = EH[slot]; e; e = eNext[e - 1]) {
      const own = eOwn[e - 1];
      if (own >= 0 && eVer[e - 1] !== ver[own]) continue;
      const a = flipE ? eB[e - 1] : eA[e - 1]; // 它在 c 的档
      const b = flipE ? eA[e - 1] : eB[e - 1]; // 在 c2 的
      if ((h - a) * (h2 - b) < 0) return false;
    }
    return true;
  };
  /** 一串格子 [x, y, h] 记进占用（同一格相邻两节之间那几档也占：原地升降的中间不许别的带子穿），边记进边表；返回占的 [格, 位] 以便拆掉 */
  // skipFirst / skipLast：头尾那一格是两头的固定格（地面段、站口、出入口），它自己那一档已经按固定的记过，这里不记（拆的时候也不动它）
  const lay = (tiles, own, skipFirst = false, skipLast = false) => {
    const marks = [];
    for (let k = 0; k < tiles.length; k++) {
      const [x, y, h] = tiles[k];
      if (!inb(x, y)) continue;
      const c = cid(x, y);
      let m = (skipFirst && k === 0) || (skipLast && k === tiles.length - 1) ? 0 : 1 << h;
      const p = k ? tiles[k - 1] : null;
      if (p && p[0] === x && p[1] === y && p[2] !== h) m |= bits(Math.min(p[2], h) + 1, Math.max(p[2], h) - 1); // 原地升降那一叠的中间几档
      m &= ~occ[c] | 0; // 已经记过的（固定格自己那一档）不重复记
      if (m) {
        occ[c] |= m;
        marks.push(c, m);
      }
      if (p && (p[0] !== x || p[1] !== y) && inb(p[0], p[1])) putEdge(cid(p[0], p[1]), p[2], c, h, own);
    }
    return marks;
  };
  const unlay = (marks) => {
    for (let k = 0; k < marks.length; k += 2) occ[marks[k]] &= ~marks[k + 1];
  };
  // 每条链固定的那几格占的位（算「同一格有没有别的链」时扣掉自己这条链的，见 search 的 others）
  const chainMarks = new Map();
  fixedTiles.forEach((t, k) => {
    const m = lay(t.map(([x, y, z]) => [x, y, H2(z)]), -1);
    const ch = fixedChain[k];
    if (!chainMarks.has(ch)) chainMarks.set(ch, []);
    chainMarks.get(ch).push(m);
  });
  // 每截的两头（固定格）+ 原来的路
  const full = (n, route) => [[n.start[0], n.start[1], 0], ...route, [n.goal[0], n.goal[1], 0]];
  nets.forEach((n, k) => {
    n.id = k;
    n.route = n.old;
    n.marks = lay(full(n, n.old), k, true, true);
  });

  // 同一格里有没有别的链（自己这条链的固定格、同一条链别的截不算）：叠格、相遇的代价只按别的链算
  const OWNS = new Int32Array(NC);
  const OWNB = new Int32Array(NC);
  let ownStamp = 0;
  const netsOfChain = new Map();
  for (const n of nets) {
    if (!netsOfChain.has(n.chain)) netsOfChain.set(n.chain, []);
    netsOfChain.get(n.chain).push(n);
  }
  const markOwn = (n) => {
    ownStamp++;
    const put = (marks) => {
      for (let k = 0; k < marks.length; k += 2) {
        const c = marks[k];
        if (OWNS[c] !== ownStamp) {
          OWNS[c] = ownStamp;
          OWNB[c] = marks[k + 1];
        } else OWNB[c] |= marks[k + 1];
      }
    };
    for (const m of chainMarks.get(n.chain) ?? []) put(m);
    for (const n2 of netsOfChain.get(n.chain) ?? []) if (n2 !== n) put(n2.marks);
  };
  const others = (c) => (OWNS[c] === ownStamp ? occ[c] & ~OWNB[c] : occ[c]);
  // 这一截原来就走在地面的格（含裁段并进来的）：分拣器手臂底下的地面照旧能走（原来就是这样），半层照样不行
  const OLDG = new Int32Array(NC);
  let oldStamp = 0;
  const markOld = (n) => {
    oldStamp++;
    for (const t of n.old) if (t[2] === 0 && inb(t[0], t[1])) OLDG[cid(t[0], t[1])] = oldStamp;
  };
  const armAt = (c) => (OLDG[c] === oldStamp ? arm[c] & ~1 : arm[c]);

  // —— 物流站的口、存的东西（原料接线换站用）——
  const portKey = (k, slot) => k * 16 + slot;
  const used = new Map(); // 站口 → 哪一截（-1 固定）
  const netOfLeg = new Map(nets.filter((n) => n.leg).map((n) => [n.leg.id, n]));
  for (const [k, st] of stations.entries()) for (const p of st.ports) used.set(portKey(k, p.slot), p.leg != null && netOfLeg.has(p.leg) ? netOfLeg.get(p.leg).id : -1);
  for (const n of nets) if (n.type === 'warper') {
    used.set(portKey(n.warper.from.k, n.warper.from.slot), n.id);
    used.set(portKey(n.warper.to.k, n.warper.to.slot), n.id);
  }
  // 每座站静态存的（不是重走的原料接线带来的）：供应、翘曲器、别的需求
  const feedNets = nets.filter((n) => n.type === 'feed');
  const feedLegs = new Set(feedNets.map((n) => n.leg.id));
  const staticItems = stations.map((st) => {
    const fromFeeds = new Set(st.ports.filter((p) => p.leg != null && feedLegs.has(p.leg)).map((p) => realItem(p.itemId)));
    const keepIds = new Set(st.ports.filter((p) => !(p.leg != null && feedLegs.has(p.leg))).map((p) => realItem(p.itemId)));
    return st.items.filter((it) => it.role !== 'demand' || !fromFeeds.has(realItem(it.itemId)) || keepIds.has(realItem(it.itemId)));
  });
  const demandUse = stations.map(() => new Map()); // 站 → 物品 → 现在几条原料接线从这里出
  for (const n of feedNets) {
    const m = demandUse[n.station.k];
    const it = realItem(n.itemId);
    m.set(it, (m.get(it) ?? 0) + 1);
  }
  const itemCount = (k) => {
    const s = new Set(staticItems[k].map((it) => realItem(it.itemId)));
    for (const [it, c] of demandUse[k]) if (c > 0) s.add(it);
    return s.size;
  };
  const has = (k, it) => staticItems[k].some((x) => realItem(x.itemId) === it && x.role === 'demand') || (demandUse[k].get(it) ?? 0) > 0;
  const supplies = (k, it) => staticItems[k].some((x) => realItem(x.itemId) === it && x.role === 'supply');
  // 增产剂的空格（keepFree）：重走在放增产剂带之后，喷涂时增产剂已经占上一格了，不用再留
  const PRO_ITEMS = new Set([1141, 1142, 1143]);
  const keepNeed = slots?.keepFree && !stations.some((st) => st.items.some((it) => PRO_ITEMS.has(realItem(it.itemId)))) ? 1 : 0;
  const freeTotal = () => stations.reduce((a, st, k) => a + STATION_SLOTS - itemCount(k), 0);

  // —— 四、A* ——
  const NS = NC * HN * 4;
  ensure(NS);
  ensureMap(2 * NC);
  const goalAt = new Int32Array(NC).fill(-1);
  const goals = [];
  const starts = [];
  let pops = 0;
  const heapPush = (n, f, s) => {
    if (n === hk.length) {
      const k2 = new Float64Array(n * 2);
      k2.set(hk);
      hk = k2;
      const v2 = new Int32Array(n * 2);
      v2.set(hv);
      hv = v2;
    }
    let i = n;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= f) break;
      hk[i] = hk[p];
      hv[i] = hv[p];
      i = p;
    }
    hk[i] = f;
    hv[i] = s;
  };
  const heapPop = (n) => {
    // 取走堆顶（调用方先读 hv[0]），n 是取走前的大小
    const lk = hk[n - 1];
    const lv = hv[n - 1];
    const m = n - 1;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= m) break;
      if (c + 1 < m && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= lk) break;
      hk[i] = hk[c];
      hv[i] = hv[c];
      i = c;
    }
    hk[i] = lk;
    hv[i] = lv;
  };
  const gx = (c) => (c % GW) + X0;
  const gy = (c) => Math.floor(c / GW) + Y0;
  /**
   * 一截的 A*：starts（[{ c, d, straight, g0, port }]）到 goals（[{ c, bad, flip, port }]）。返回 { tiles: [x, y, h]（两头之间）, start, goal, cost }，走不通 null
   */
  /**
   * 启发值的地图：从终点倒着做一遍两层（地面 / 空中）的 Dijkstra，每格每层到终点的代价下限（A* 的走法放宽了：空中不分哪一档，
   * 一格的空中能走就按空着的档里最便宜的 a 算，地面、空中之间换一次按 tau，不管拐弯、上下对调和原地升降），所以不比真的代价大，
   * 而且是一致的（每一步的真代价不小于地图两头的差）。起点四周的格都定下来、再往外 slack 以后就停，没定的格按停的时候的前沿值算（也是下限）
   */
  const AIR = bits(1, MAXH);
  let front = 0;
  let mapMs = 0;
  let mapPops = 0;
  // U：只要代价不超过 U 的路时（上一遍找到过一条，见下面排的那一段），只算起点到它、它到终点加起来可能不超过 U 的格（以起点、终点为焦点的椭圆），
  // 前沿过了 U 就停，没算到的格当走不到——代价不超过 U 的路上的格都在里面、值和整张算的一样，所以找到的路和不设 U 一字不差
  const buildMap = (avoidMask, ringK, U = Infinity) => {
    mstamp++;
    const ms = mstamp;
    let size = 0;
    const tau = opts.tau;
    const mpush = (v, f) => {
      if (size === mk.length) {
        const k2 = new Float64Array(size * 2);
        k2.set(mk);
        mk = k2;
        const v2 = new Int32Array(size * 2);
        v2.set(mv);
        mv = v2;
      }
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (mk[p] <= f) break;
        mk[i] = mk[p];
        mv[i] = mv[p];
        i = p;
      }
      mk[i] = f;
      mv[i] = v;
    };
    const mpop = () => {
      const lk = mk[size - 1];
      const lv = mv[size - 1];
      const m = --size;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= m) break;
        if (c + 1 < m && mk[c + 1] < mk[c]) c++;
        if (mk[c] >= lk) break;
        mk[i] = mk[c];
        mv[i] = mv[c];
        i = c;
      }
      mk[i] = lk;
      mv[i] = lv;
    };
    // 起点四周要定下来的格（WANT 记这一次的戳）
    let pending = 0;
    for (const s0 of starts) {
      const x = gx(s0.c), y = gy(s0.c);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!inb(nx, ny)) continue;
        const c = cid(nx, ny);
        if (WANT[c] !== ms) {
          WANT[c] = ms;
          pending++;
        }
      }
    }
    for (const q of goals) {
      MD[2 * q.c] = 0;
      MS[2 * q.c] = ms;
      mpush(2 * q.c, 0);
    }
    let cap = Infinity;
    front = 0;
    const over = opts.over;
    const meet = opts.meet;
    // 起点那一圈的外接框（几个起点时按框算到这一格的曼哈顿距离：不比到最近那个起点的远，照样是下限）
    const bound = U !== Infinity;
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    if (bound) for (const s0 of starts) {
      const sx = s0.c % GW;
      const sy = (s0.c - sx) / GW;
      if (sx < bx0) bx0 = sx;
      if (sx > bx1) bx1 = sx;
      if (sy < by0) by0 = sy;
      if (sy > by1) by1 = sy;
    }
    while (size) {
      const v = mv[0];
      const dv = mk[0];
      mpop();
      if (MC[v] === ms) continue;
      MC[v] = ms;
      mapPops++;
      front = dv;
      if (bound ? dv > U : dv > cap) break;
      const c2 = v >> 1;
      const L2 = v & 1;
      if (WANT[c2] === ms) {
        WANT[c2] = 0;
        if (!--pending) cap = dv + 24;
      }
      // 走进 (c2, L2) 这一步的代价（不含换层）
      let enter;
      const gi = goalAt[c2];
      const oc = others(c2);
      const isGoal = gi >= 0 && L2 === 0;
      const edge = outer[c2] + RING[c2] + ringK * RINGW[c2];
      if (isGoal) enter = 1 + edge + goals[gi].g0;
      else if (L2 === 0) enter = 1 + edge + (oc ? over : 0);
      else enter = 1 + MINA[~(blk[c2] | occ[c2] | arm[c2]) & AIR] + edge + (oc ? over : 0);
      const meetHere = !isGoal && oc ? meet : 0; // 从没有别的链的格走进有的：这一步另加 meet（见 search）
      const x2 = c2 % GW;
      const y2 = (c2 - x2) / GW;
      for (let d = 0; d < 4; d++) {
        let c;
        if (bound) {
          // 起点到这一格至少还要走曼哈顿距离那么多格（每格至少 1）：加上它到终点的下限超过 U 的不算
          const cx = d === 0 ? x2 - 1 : d === 1 ? x2 + 1 : x2;
          const cy = d === 2 ? y2 - 1 : d === 3 ? y2 + 1 : y2;
          if (dv + 1 + (cx < bx0 ? bx0 - cx : cx > bx1 ? cx - bx1 : 0) + (cy < by0 ? by0 - cy : cy > by1 ? cy - by1 : 0) > U) continue;
        }
        if (d === 0) {
          if (x2 === 0) continue;
          c = c2 - 1;
        } else if (d === 1) {
          if (x2 === GW - 1) continue;
          c = c2 + 1;
        } else if (d === 2) {
          c = c2 - GW;
          if (c < 0) continue;
        } else {
          c = c2 + GW;
          if (c >= NC) continue;
        }
        if (avoidMask && avoidMask.has(c)) continue;
        const used = blk[c] | occ[c] | armAt(c);
        const step = enter + (meetHere && !others(c) ? meetHere : 0) + exitCost(c, c2);
        if (!(used & 1)) {
          const u = 2 * c;
          if (MC[u] !== ms) {
            const nd = dv + step + (L2 ? tau : 0);
            if (MS[u] !== ms || MD[u] > nd) {
              MS[u] = ms;
              MD[u] = nd;
              mpush(u, nd);
            }
          }
        }
        if (~used & AIR) {
          const u = 2 * c + 1;
          if (MC[u] !== ms) {
            const nd = dv + step + (L2 ? 0 : tau);
            if (MS[u] !== ms || MD[u] > nd) {
              MS[u] = ms;
              MD[u] = nd;
              mpush(u, nd);
            }
          }
        }
      }
    }
    if (bound || (!size && cap === Infinity)) front = Infinity; // 都定了（地图里够得着的都算完了），或者只算了 U 以内的：没定的就是走不到（或用不上）
    return ms;
  };
  // 每格空中那几档里最便宜的 a（按空着的档的位查表）
  // 查表的下标是空着的档 & AIR（第 1..MAXH 档），表只要 2^(MAXH+1) 那么大
  const MINA = new Float64Array(2 ** (MAXH + 1));
  for (let m = 1; m < MINA.length; m++) {
    let v = Infinity;
    for (let h = 1; h <= MAXH; h++) if (m & (1 << h) && AH[h] < v) v = AH[h];
    MINA[m] = v;
  }
  const search = (n, avoidMask = null, U = Infinity) => {
    markOwn(n);
    markOld(n);
    const ringK = n.type === 'warper' ? 1 : 0;
    stamp++;
    const st = stamp;
    let size = 0;
    const tau = opts.tau;
    const tm = performance.now();
    const ms = buildMap(avoidMask, ringK, U);
    mapMs += performance.now() - tm;
    const lim = front;
    const heur = (c, h, d) => {
      const u = 2 * c + (h ? 1 : 0);
      const base = MC[u] === ms ? MD[u] : lim;
      if (base === Infinity) return Infinity;
      const x = gx(c), y = gy(c);
      let t = 4;
      for (const q of goals) {
        const k = minTurns(d, q.x - x, q.y - y);
        if (k < t) t = k;
      }
      return base + (h ? tau * (h - 1) : 0) + opts.turn * t;
    };
    for (let k = 0; k < starts.length; k++) {
      const s0 = starts[k];
      const d = s0.d < 0 ? 0 : s0.d;
      const s = (s0.c * HN) * 4 + d;
      if (ST[s] === st && G[s] <= s0.g0) continue;
      ST[s] = st;
      G[s] = s0.g0;
      PR[s] = -1 - k;
      LF[s] = 0;
      heapPush(size++, s0.g0, s);
    }
    const budget = opts.budget;
    while (size) {
      const s = hv[0];
      heapPop(size--);
      if (CL[s] === st) continue;
      CL[s] = st;
      if (++pops > 4e9) break;
      if (budget && --n.left < 0) return null;
      const d = s & 3;
      const h = (s >> 2) % HN;
      const c = Math.floor(s / 4 / HN);
      const g = G[s];
      if (PR[s] >= 0 && h === 0 && goalAt[c] >= 0 && goals[goalAt[c]].reached === st) {
        // 到了终点
        return backtrack(s, goals[goalAt[c]]);
      }
      const atStart = PR[s] < 0;
      const s0 = atStart ? starts[-1 - PR[s]] : null;
      const dFree = atStart && s0.d < 0; // 链头，没有来路：朝哪都行
      const x = gx(c), y = gy(c);
      const ocHere = others(c);
      for (let nd = 0; nd < 4; nd++) {
        if (!dFree && nd === back(d)) continue;
        if (atStart && s0.straight && nd !== d) continue;
        const nx = x + DX[nd], ny = y + DY[nd];
        if (!inb(nx, ny)) continue;
        const c2 = cid(nx, ny);
        const turned = !dFree && nd !== d;
        const gi = goalAt[c2];
        const hLo = Math.max(0, h - DMAX), hHi = Math.min(MAXH, h + DMAX);
        for (let h2 = hLo; h2 <= hHi; h2++) {
          const dh = h2 > h ? h2 - h : h - h2;
          let cost = 1 + AH[h2] + tau * dh + (dh === 2 ? opts.steep : 0) + (turned ? opts.turn : 0) + (dh && turned ? opts.slopeTurn : 0) + outer[c2] + RING[c2] + ringK * RINGW[c2] + exitCost(c, c2);
          if (gi >= 0 && h2 === 0) {
            const q = goals[gi];
            if (nd === q.bad) continue;
            if (!edgeOk(c, h, c2, 0)) continue;
            const s2 = (c2 * HN) * 4 + nd;
            const ng = g + cost + q.g0 + (q.out >= 0 && nd !== q.out ? opts.turn : 0); // 拐进终点那一格也算一次拐弯
            if (ST[s2] === st && G[s2] <= ng) continue;
            ST[s2] = st;
            G[s2] = ng;
            PR[s2] = s;
            LF[s2] = 0;
            q.reached = st;
            heapPush(size++, ng - TIE * ng, s2);
            continue;
          }
          const bit = 1 << h2;
          if ((blk[c2] | occ[c2] | armAt(c2)) & bit) continue;
          if (avoidMask && avoidMask.has(c2)) continue;
          if (others(c2)) cost += opts.over + (ocHere ? 0 : opts.meet);
          if (!edgeOk(c, h, c2, h2)) continue;
          const s2 = ((c2 * HN) + h2) * 4 + nd;
          const ng = g + cost;
          if (ST[s2] === st && G[s2] <= ng) continue;
          ST[s2] = st;
          G[s2] = ng;
          PR[s2] = s;
          LF[s2] = 0;
          const f = ng + heur(c2, h2, nd);
          if (f === Infinity) continue;
          heapPush(size++, f - TIE * ng, s2);
        }
        // 原地竖直升降：在这一格一层层升（降），再直着走到下一格（只在直行的格子里：进来和出去同一个方向）
        if (noLift || turned || dFree) continue;
        if (atStart && s0.straight) continue; // 站身里不升降
        const here = blk[c] | occ[c] | armAt(c);
        for (const step of [2, -2]) {
          let extra = 0;
          for (let hl = h + step; hl >= 0 && hl <= MAXH; hl += step) {
            // 这一格从 h 到 hl 之间（不含 h）都要空着
            const lo = Math.min(h, hl), hi = Math.max(h, hl);
            if (here & (bits(lo, hi) & ~(1 << h))) break;
            extra += 2 * tau + opts.lift + 1 + AH[hl];
            const gi2 = goalAt[c2];
            const cost = 1 + AH[hl] + outer[c2] + RING[c2] + ringK * RINGW[c2] + exitCost(c, c2) + extra;
            if (gi2 >= 0 && hl === 0) {
              const q = goals[gi2];
              if (nd === q.bad || !edgeOk(c, 0, c2, 0)) continue;
              const s2 = (c2 * HN) * 4 + nd;
              const ng = g + cost + q.g0 + (q.out >= 0 && nd !== q.out ? opts.turn : 0);
              if (ST[s2] === st && G[s2] <= ng) continue;
              ST[s2] = st;
              G[s2] = ng;
              PR[s2] = s;
              LF[s2] = 1;
              q.reached = st;
              heapPush(size++, ng - TIE * ng, s2);
              continue;
            }
            if ((blk[c2] | occ[c2] | armAt(c2)) & (1 << hl)) continue;
            if (avoidMask && avoidMask.has(c2)) continue;
            if (!edgeOk(c, hl, c2, hl)) continue;
            const s2 = ((c2 * HN) + hl) * 4 + nd;
            const ng = g + cost + (others(c2) ? opts.over + (ocHere ? 0 : opts.meet) : 0);
            if (ST[s2] === st && G[s2] <= ng) continue;
            ST[s2] = st;
            G[s2] = ng;
            PR[s2] = s;
            LF[s2] = 1;
            const f = ng + heur(c2, hl, nd);
            if (f === Infinity) continue;
            heapPush(size++, f - TIE * ng, s2);
          }
        }
      }
    }
    return null;
  };
  const backtrack = (s, q) => {
    const states = [];
    let cur = s;
    while (cur >= 0) {
      states.push(cur);
      cur = PR[cur];
    }
    const start = starts[-1 - cur];
    states.reverse();
    const tiles = [];
    for (let k = 1; k < states.length; k++) {
      const a = states[k - 1];
      const b = states[k];
      const ha = (a >> 2) % HN;
      const hb = (b >> 2) % HN;
      const ca = Math.floor(a / 4 / HN);
      const cb = Math.floor(b / 4 / HN);
      if (LF[b]) for (let hh = ha + (hb > ha ? 2 : -2); hb > ha ? hh <= hb : hh >= hb; hh += hb > ha ? 2 : -2) tiles.push([gx(ca), gy(ca), hh]);
      if (k < states.length - 1) tiles.push([gx(cb), gy(cb), hb]);
    }
    return { tiles, start, goal: q, cost: G[s] };
  };

  // 一截的起点、终点（原料接线换站、翻段的选项在这里展开）
  const prepare = (n) => {
    starts.length = 0;
    for (const q of goals) goalAt[q.c] = -1;
    goals.length = 0;
    const addGoal = (x, y, bad, extra = {}) => {
      if (!inb(x, y)) return;
      const c = cid(x, y);
      if (goalAt[c] >= 0) return;
      goalAt[c] = goals.length;
      goals.push({ c, x, y, bad, g0: 0, reached: 0, ...extra });
    };
    const startAt = (x, y, d, straight, g0 = 0, extra = {}) => {
      if (inb(x, y)) starts.push({ c: cid(x, y), d, straight, g0, ...extra });
    };
    if (n.type === 'feed' && opts.resource) {
      const it = realItem(n.itemId);
      for (const [k, st] of stations.entries()) {
        const own = k === n.station.k;
        const hasIt = has(k, it);
        let g0 = own ? 0 : 0.5;
        // 原来那座站：照旧能回去（拆掉时让出来的那一格还给它）
        if (!hasIt && !own) {
          if (supplies(k, it)) continue; // 同种物品的供应和需求不进同一座站
          if (itemCount(k) >= STATION_SLOTS) continue;
          if (freeTotal() - 1 < keepNeed) continue;
          g0 += opts.newSlot;
        }
        for (const q of STATION_PORTS) {
          const pk = portKey(k, q.slot);
          if (used.has(pk) && used.get(pk) !== n.id) continue;
          startAt(st.x + q.dx + q.nx, st.y + q.dy + q.ny, dirOf(q.nx, q.ny), true, g0, { port: { k, slot: q.slot, cell: [st.x + q.dx, st.y + q.dy] } });
        }
      }
    } else startAt(n.start[0], n.start[1], n.startDir, !!n.straight);
    if (n.type === 'feed' && n.flipSeg) {
      // 只有一段的原料带：段头照原来的方向进；能翻时也可以接段尾、整段反着流（进的那一格不能从段里那一格来）
      const sg = n.flipSeg;
      const out = dirOf(sg.dir, 0);
      addGoal(sg.entryX, sg.y, back(out), { out });
      if (opts.flip && sg.exitX !== sg.entryX) addGoal(sg.exitX, sg.y, out, { out: back(out), flip: true });
    } else addGoal(n.goal[0], n.goal[1], n.goalOut >= 0 ? back(n.goalOut) : -1, { out: n.goalOut });
  };
  /** 路自己压到自己的格（同一格不连着走了两次，或者从两头的固定格上空又走过） */
  const dupOf = (r) => {
    const seen = new Set([r.start.c]);
    const dup = new Set();
    let prev = r.start.c;
    for (const [x, y] of r.tiles) {
      const c = cid(x, y);
      if (c !== prev && seen.has(c)) dup.add(c);
      seen.add(c);
      prev = c;
    }
    if (seen.has(r.goal.c)) dup.add(r.goal.c);
    return dup;
  };

  // 一截写回去之前先在表里放上它的新路
  const setupMs = performance.now() - t0;
  const order = nets.slice().sort((a, b) => b.old.length - a.old.length || a.id - b.id);
  let kept = 0;
  let selfFix = 0;
  const totalBudget = opts.budget > 0 ? opts.budget : Infinity;
  const sameRoute = (a, b) => a.length === b.length && a.every((t, k) => t[0] === b[k][0] && t[1] === b[k][1] && t[2] === b[k][2]);
  let passesRun = 0;
  for (let pass = 0; pass < opts.passes; pass++) {
    passesRun++;
    let changed = 0;
    for (const n of order) {
      // 前一遍把展开上限用光也没找到的：多半还是找不到，后面几遍不再找，留着原来的路
      if (n.dead) continue;
      // 拆掉
      unlay(n.marks);
      ver[n.id]++;
      if (n.type === 'feed') {
        used.delete(portKey(n.station.k, n.station.slot));
        const m = demandUse[n.station.k];
        const it = realItem(n.itemId);
        m.set(it, (m.get(it) ?? 1) - 1);
      }
      prepare(n);
      // 离开的那座站不能空掉（最后一个口）：只有这一个口时原来那座站之外的起点去掉
      if (n.type === 'feed' && opts.resource) {
        const k0 = n.station.k;
        const busy = [...used.keys()].some((q) => Math.floor(q / 16) === k0);
        if (!busy) for (let i = starts.length - 1; i >= 0; i--) if (starts[i].port && starts[i].port.k !== k0) starts.splice(i, 1);
      }
      n.left = totalBudget;
      // 第二遍起：上一遍找到的那条路还在（别人排的时候让开了它的格），它现在的代价比上一遍多不了多少（只多别人新挨过来的叠格、相遇），
      // 先只找代价不超过它 1.1 倍加 5 的路（见 buildMap 的 U）；找不到再整张找。两种找法找到的路一样
      const U = pass > 0 && Number.isFinite(n.cost) ? n.cost * 1.1 + 5 : Infinity;
      let r = search(n, null, U);
      if (!r && U !== Infinity) {
        n.left = totalBudget;
        r = search(n);
      }
      // 自己压到自己：把重复的格挡住再找，最多两次，还压着就当没找到
      let avoid = null;
      for (let t = 0; r && t < 3; t++) {
        const dup = dupOf(r);
        if (!dup.size) break;
        if (t === 2) {
          r = null;
          break;
        }
        selfFix++;
        avoid = new Set([...(avoid ?? []), ...dup]);
        n.left = totalBudget;
        r = search(n, avoid);
      }
      if (r) {
        if (!sameRoute(r.tiles, n.route) || !!r.goal.flip || (r.start.port && (r.start.port.k !== n.station.k || r.start.port.slot !== n.station.slot))) changed++;
        n.route = r.tiles;
        n.cost = r.cost;
        if (n.type === 'feed' && r.start.port) {
          n.station = { k: r.start.port.k, slot: r.start.port.slot };
          n.start = [gx(r.start.c), gy(r.start.c)];
          n.portCell = r.start.port.cell;
        }
        n.flipped = !!r.goal.flip;
        n.goal = [r.goal.x, r.goal.y];
      } else {
        kept++;
        if (n.left < 0) n.dead = true;
      }
      if (n.type === 'feed') {
        used.set(portKey(n.station.k, n.station.slot), n.id);
        const m = demandUse[n.station.k];
        const it = realItem(n.itemId);
        m.set(it, (m.get(it) ?? 0) + 1);
      }
      n.marks = lay(full(n, n.route), n.id, true, true);
      if (n.flipped && n.flipSeg && r) {
        // 接的是段尾：这一段翻过来（下一遍再按翻过的段找两头）
        const s = n.flipSeg;
        s.dir = -s.dir;
        s.dout = -s.dout;
        [s.entryX, s.exitX] = [s.exitX, s.entryX];
        n.flipped = false;
        n.flips = (n.flips ?? 0) + 1;
      }
    }
    // 这一遍谁都没变：再排一遍也一样（同样的表、同样的次序、A* 是确定的），不用再排
    if (!changed) break;
  }

  const passMs = performance.now() - t0 - setupMs;
  // —— 五、写回 ——
  const Z = (tiles) => tiles.map(([x, y, h]) => [x, y, h / 2]);
  let switched = 0;
  for (const n of nets) {
    const r = Z(n.route);
    const l = n.leg;
    if (n.type === 'link' || n.type === 'edgeIn' || n.type === 'edgeOut') {
      l.cells = r;
      l.shadow = [];
      l.level = Math.max(0, ...r.map((q) => q[2]));
    } else if (n.type === 'feed' || n.type === 'sink') {
      const pc = [n.portCell[0], n.portCell[1], 0];
      const be = [n.start[0], n.start[1], 0];
      if (n.type === 'feed') l.stub = [pc, be, ...r];
      else l.stub = [[n.portCell[0], n.portCell[1], 0], [n.goal[0], n.goal[1], 0], ...r.slice().reverse()];
      l.cells = [];
      l.shadow = [];
      l.level = 0;
      l.direct = true;
      const target = n.type === 'feed' ? n.goal : n.start;
      [l.edge, l.py] = target;
      if (n.port) {
        n.port.x = target[0];
        n.port.y = target[1];
        n.port.direct = true;
      }
      if (n.type === 'feed') {
        if (l.station.k !== n.station.k || l.station.slot !== n.station.slot) switched++;
        l.station = { ...n.station };
        if (n.port) {
          n.port.station = n.station.k;
          n.port.slot = n.station.slot;
        }
      }
    } else if (n.type === 'warper') {
      const c = n.warper.cells;
      n.warper.cells = [c[0], c[1], ...r, c[c.length - 2], c[c.length - 1]];
    }
  }
  // 站的口和存的东西照最后的接法重排：原料接线的口按现在接在哪座站；存储格先留原来还用得上的（顺序不变），再补新加的
  if (feedNets.length && opts.resource) {
    for (const [k, st] of stations.entries()) {
      st.ports = st.ports.filter((p) => !(p.leg != null && feedLegs.has(p.leg)));
      for (const n of feedNets) if (n.station.k === k) st.ports.push({ slot: n.station.slot, leg: n.leg.id, itemId: n.port?.itemId ?? n.itemId, dir: 'out' });
      const need = new Set(st.ports.map((p) => realItem(p.itemId)));
      const items = st.items.filter((it) => it.role !== 'demand' || need.has(realItem(it.itemId)) || !feedNets.some((n) => realItem(n.itemId) === realItem(it.itemId)));
      for (const n of feedNets) if (n.station.k === k && !items.some((it) => realItem(it.itemId) === realItem(n.itemId))) items.push({ itemId: realItem(n.itemId), role: 'demand' });
      st.items = items;
    }
  }
  const flipped = nets.reduce((a, n) => a + (n.flips ?? 0) % 2, 0);
  cropToContent(L);
  L.reroute = { nets: nets.length, passes: passesRun, kept, switched, flipped, selfFix, pops, mapPops, mapMs: Math.round(mapMs), powMs: Math.round(powMs), setupMs: Math.round(setupMs), passMs: Math.round(passMs), ms: Math.round(performance.now() - t0) };
  return L;
}

/**
 * 一张布局的带子量（守门用，口径照 src/metrics/crossings.js，只是直接看布局不出蓝图）：每条链的主链、劈开的死胡同那半、翘曲器带、增产剂带各算一条。
 * nodes 节数、air 离地的节、lifts 原地升降的节（同一格前后两节高度不同）、top 最高层、stacked 叠格（一格里两条以上）、meet 相遇（两条共用的格按相邻连成一处处）
 */
export function beltStats(L) {
  const runs = [];
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    runs.push(t.main, ...t.extra);
  }
  for (const w of L.warperLinks || []) runs.push(w.cells);
  for (const p of L.proLines || []) runs.push(p.cells);
  let nodes = 0, air = 0, lifts = 0, top = 0, turns = 0;
  const at = new Map(); // "x,y" → 这一格有哪几条（序号）
  runs.forEach((t, ri) => {
    nodes += t.length;
    // 拐弯：相邻两步的平面方向不同算一次，原地升降那几步跳过（同 crossings.js 的 turns）
    let pd = null;
    for (let k = 1; k < t.length; k++) {
      const d = Math.sign(t[k][0] - t[k - 1][0]) * 3 + Math.sign(t[k][1] - t[k - 1][1]);
      if (!d) continue;
      if (pd != null && d !== pd) turns++;
      pd = d;
    }
    for (let k = 0; k < t.length; k++) {
      const [x, y, z] = t[k];
      if (z >= 0.1) air++;
      if (z > top) top = z;
      if (k && t[k - 1][0] === x && t[k - 1][1] === y && t[k - 1][2] !== z) lifts++;
      const key = `${x},${y}`;
      const s = at.get(key);
      if (!s) at.set(key, [ri]);
      else if (!s.includes(ri)) s.push(ri);
    }
  });
  let stacked = 0;
  const pairs = new Map();
  for (const [key, s] of at) {
    if (s.length < 2) continue;
    stacked++;
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++) {
        const pk = s[i] < s[j] ? `${s[i]}|${s[j]}` : `${s[j]}|${s[i]}`;
        (pairs.get(pk) ?? pairs.set(pk, []).get(pk)).push(key);
      }
  }
  let meet = 0;
  for (const keys of pairs.values()) {
    const left = new Set(keys);
    for (const k0 of keys) {
      if (!left.has(k0)) continue;
      left.delete(k0);
      meet++;
      const q = [k0];
      while (q.length) {
        const [x, y] = q.pop().split(',').map(Number);
        for (const k2 of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) if (left.has(k2)) {
          left.delete(k2);
          q.push(k2);
        }
      }
    }
  }
  return { nodes, air, lifts, top, stacked, meet, turns };
}

/**
 * 卫星配电站顶盘那一圈（离中心正好 SUBSTATION_DISK.reach 格、4.18~5.27 层）里有几节带子：独立检查（emit/check.js）报「顶盘撞上高架带」，
 * 网页、考卷会换种子重排。搜索和放供电都不看带子的高度，主干的图偶尔会撞；重走的新路接卫星配电站时不上 4 层以上，不会撞
 */
export function diskHits(L) {
  if (L.power?.itemId !== 2212 || !L.power.nodes?.length) return 0;
  const R = SUBSTATION_DISK.reach;
  const ring = new Set();
  for (const n of L.power.nodes)
    for (let x = n.x - R; x <= n.x + R; x++) for (let y = n.y - R; y <= n.y + R; y++) if (Math.max(Math.abs(x - n.x), Math.abs(y - n.y)) === R) ring.add(`${x},${y}`);
  let hits = 0;
  const scan = (t) => {
    for (const [x, y, z] of t) if (z > SUBSTATION_DISK.lo && z < SUBSTATION_DISK.hi && ring.has(`${x},${y}`)) hits++;
  };
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    scan(t.main);
    for (const e of t.extra) scan(e);
  }
  for (const w of L.warperLinks || []) scan(w.cells);
  for (const p of L.proLines || []) scan(p.cells);
  return hits;
}

/**
 * 守门：重走后的那张哪一项都不比原来的差（带子节数、离地、原地升降、最高层、叠格、相遇、面积、最终代价，可行、供电覆盖、撞顶盘），返回差了的那几项（空数组是都不差）。
 * 原来那张有带子撞上卫星配电站的顶盘（贴不进游戏、要重排）、重走以后一处不撞的，带子那几项和最终代价不比，只看面积、可行、供电。
 * turns：拐弯也比（实验开关 turnGuard）
 */
export function rerouteWorse(oldL, oldS, newL, newS, { turns = false } = {}) {
  const why = [];
  const hOld = diskHits(oldL), hNew = diskHits(newL);
  const fixes = hOld > 0 && hNew === 0;
  const keys = turns ? ['nodes', 'air', 'lifts', 'top', 'stacked', 'meet', 'turns'] : ['nodes', 'air', 'lifts', 'top', 'stacked', 'meet'];
  if (!fixes) for (const k of keys) if (newS[k] > oldS[k] + 1e-9) why.push(`${k} ${oldS[k]}→${newS[k]}`);
  if (hNew > hOld) why.push(`撞顶盘 ${hOld}→${hNew}`);
  if (newL.area > oldL.area) why.push(`area ${oldL.area}→${newL.area}`);
  if (!fixes && newL.finalCost > oldL.finalCost + 1e-6) why.push(`finalCost ${Math.round(oldL.finalCost)}→${Math.round(newL.finalCost)}`);
  if (oldL.feasible && !newL.feasible) why.push('不可行');
  if ((newL.power?.uncovered ?? 0) > (oldL.power?.uncovered ?? 0)) why.push('供电没覆盖');
  return why;
}
