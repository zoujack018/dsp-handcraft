// 把规划好的布局翻译成游戏蓝图（建筑、分拣器、传送带及其连接），再编码成蓝图字符串。
//
// 记录格式沿用 antian369/dsp-calc 已在游戏里验证过的写法：
//   - 工厂：中心坐标，yaw 0，parameters {acceleratorMode: 0}，recipeId。
//   - 分拣器：起点/终点分别落在传送带格子或工厂边缘（熔炉、制造台中心上下 1 格），
//     下侧槽位 中心+1/0/-1 = 6/7/8，上侧槽位 中心-1/0/+1 = 0/1/2（0 号已实测）；
//     化工厂下侧落在中心 −1 再往上 0.284、槽位 中心-1/0/+1 = 6/5/4，上侧落在中心 +2、槽位 0/1/2，
//     向上 yaw 0、向下 yaw 180，parameters {length}。
//   - 传送带：方向完全由 outputObjIdx 链决定，这里 yaw 写实际朝向，便于阅读。
//   - 高架：同一格里 z 差 1 的两节带子直接相连就是垂直升降。错开的写法照游戏里手动拉的官方垂直传送带
//     （2026/10/03 用户贴的蓝图）：一叠里按流向，进入的那一节往来路方向错开最多（还剩几节到出口就错几个 0.0016），
//     逐节往前挪，出口那一节正好在格子中心。抬升、落下都这样，带子在游戏里看起来是一根往前走的直的垂直带。
//     antian 原来的写法落下时往去路方向错开，一叠里的节点会先往前再往回，游戏里画出来是折返的。
import buildingsData from '../../data/Buildings.json' with { type: 'json' };
import { toStr } from '../codec/parser.js';
import { BELT_IDS, realItem, slotPoint, THERMAL_PLANT, THERMAL_BANK } from '../gamedata.js';
import { coaterYaw } from '../plan/addons.js';
import { bankSorters } from '../plan/burn.js';
import { rotateBlueprint } from './rotate.js';

const TEMPLATE = new Map(Object.values(buildingsData.buildings).map((b) => [b.itemId, b]));
// 自动集装机不在 antian 的模板里，照用户的分馏阵列蓝图补上（modelIndex 257，口位 14/15 和别的设备一样）
if (!TEMPLATE.has(2040)) {
  TEMPLATE.set(2040, { index: -1, itemId: 2040, modelIndex: 257, areaIndex: 0, localOffset: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }], yaw: [0, 0], tilt: 0, pitch: 0, tilt2: 0, pitch2: 0, outputObjIdx: -1, inputObjIdx: -1, outputToSlot: 14, inputFromSlot: 15, outputFromSlot: 15, inputToSlot: 14, outputOffset: 0, inputOffset: 0, recipeId: 0, filterId: 0, parameters: null });
}
// 火力发电厂也不在 antian 的模板里，照用户 2026/10/07 贴来的那张（test/fixtures/ref-thermal-bank.bp.txt）补上
if (!TEMPLATE.has(THERMAL_PLANT)) {
  TEMPLATE.set(THERMAL_PLANT, { index: -1, itemId: THERMAL_PLANT, modelIndex: THERMAL_BANK.modelIndex, areaIndex: 0, localOffset: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }], yaw: [THERMAL_BANK.yaw, THERMAL_BANK.yaw], tilt: 0, pitch: 0, tilt2: 0, pitch2: 0, outputObjIdx: -1, inputObjIdx: -1, outputToSlot: 0, inputFromSlot: 0, outputFromSlot: 0, inputToSlot: 0, outputOffset: 0, inputOffset: 0, recipeId: 0, filterId: 0, parameters: null });
}
const fresh = (itemId) => {
  const t = TEMPLATE.get(itemId);
  if (!t) throw new Error(`缺少建筑模板 ${itemId}`);
  const b = structuredClone(t);
  delete b.itemName;
  delete b.attributes;
  return b;
};
const HEADING = { E: 90, W: 270, N: 0, S: 180 };
const LIFT_SHIFT = 0.0016;
export const GAME_VERSION = '0.10.32.25552';

const range = (from, to) => {
  const out = [];
  const step = from <= to ? 1 : -1;
  for (let x = from; step > 0 ? x <= to : x >= to; x += step) out.push(x);
  return out;
};

/**
 * 一种物品的整条带子，按流向列出每一格 [x, y, z]。劈开的段里死胡同那一半单独成链。
 * @returns {{main: number[][], extra: number[][][], inPort: boolean, outPort: boolean}}
 */
export function chainTiles(layout, chain) {
  const main = [];
  const extra = [];
  let inPort = false;
  let outPort = false;
  let inStation = null; // 原料从物流站的哪个口出来：{k, slot}
  let outStation = null; // 成品进物流站的哪个口
  for (const part of chain.parts) {
    if (part.leg != null) {
      const l = layout.legs[part.leg];
      if (l.kind === 'in') {
        inPort = true;
        // 物流站：先是站口那两节短带（从站往外），再到走廊里的出入口格
        if (l.stub) {
          main.push(...l.stub);
          inStation = l.station;
        }
        if (l.pre) main.push(...l.pre); // 边缘入口往外接出去的几节（给喷涂机腾地方，见 plan/addons.js）
        if (!l.direct) main.push([l.edge, l.py, 0]);
        main.push(...l.cells);
      } else if (l.kind === 'out') {
        outPort = true;
        main.push(...l.cells);
        if (!l.direct) main.push([l.edge, l.py, 0]);
        if (l.stub) {
          main.push(...l.stub.slice().reverse());
          outStation = l.station;
        }
      } else {
        main.push(...l.cells);
      }
      continue;
    }
    const s = layout.segments[part.seg];
    if (s.split == null) {
      const xs = s.dir > 0 ? range(s.a, s.b) : range(s.b, s.a);
      main.push(...xs.map((x) => [x, s.y, 0]));
    } else {
      const left = s.split > s.a ? range(s.split - 1, s.a).map((x) => [x, s.y, 0]) : [];
      const right = range(s.split, s.b).map((x) => [x, s.y, 0]);
      if (s.cont === 'L') {
        main.push(...left);
        if (right.length) extra.push(right);
      } else if (s.cont === 'R') {
        main.push(...right);
        if (left.length) extra.push(left);
      } else {
        if (left.length) extra.push(left);
        if (right.length) extra.push(right);
      }
    }
  }
  return { main, extra, inPort, outPort, inStation, outStation };
}

/**
 * @param graph 生产图
 * @param layout route() 的结果
 * @param {{belt?: 1|2|3, sorter?: number, title?: string, targetId?: number}} opt
 */
export function emitBlueprint(graph, layout, opt = {}) {
  const beltId = BELT_IDS[opt.belt ?? 3];
  const sorterId = opt.sorter ?? 2013;
  const buildings = [];
  const add = (b) => {
    b.index = buildings.length;
    buildings.push(b);
    return b;
  };
  // 供电在左侧或下方外沿加了地时，布局坐标会出现负数，出蓝图时整体平移回来
  const ox = layout.origin?.x ?? 0;
  const oy = layout.origin?.y ?? 0;
  const at = (x, y, z = 0) => [
    { x: x + ox, y: y + oy, z },
    { x: x + ox, y: y + oy, z },
  ];

  // ---------- 工厂 ----------
  const factoryOf = new Map(); // "块ID#i" -> 建筑
  layout.rows.forEach((row, r) => {
    const cy = layout.rowCy[r];
    for (const bid of row) {
      const p = layout.pos.get(bid);
      p.centers.forEach((cx, i) => {
        const f = fresh(p.g.factoryId);
        f.localOffset = at(cx, cy);
        f.yaw = [0, 0];
        f.recipeId = p.g.recipeId;
        f.parameters = p.g.kind === 'lab' ? { researchMode: 1, acceleratorMode: 0 } : { acceleratorMode: 0 };
        factoryOf.set(`${bid}#${i}`, add(f));
        // 研究站往上叠：每层 z 加 levelZ，上面一台的 inputObjIdx 指向下面一台（antian 的写法）；分拣器只接最底下那台
        let below = f;
        for (let lv = 1; lv < (p.g.levels ?? 1); lv++) {
          const u = fresh(p.g.factoryId);
          u.localOffset = at(cx, cy, p.g.levelZ * lv);
          u.yaw = [0, 0];
          u.recipeId = p.g.recipeId;
          u.parameters = { researchMode: 1, acceleratorMode: 0 };
          u.inputObjIdx = below.index;
          below = add(u);
        }
      });
    }
  });

  // ---------- 物流站 ----------
  // 存储：原料设为需求（本地、星际都需求），成品设为供应；站口：出站 dir 1、进站 dir 2，storageIdx 从 1 起
  const SPRAY_ITEMS = new Set([1141, 1142, 1143]); // 增产剂 Mk.I~III
  const stationB = [];
  for (const st of layout.stations || []) {
    const b = fresh(2104);
    b.localOffset = at(st.x, st.y);
    b.yaw = [0, 0];
    const tpl = TEMPLATE.get(2104).parameters;
    const params = structuredClone(tpl);
    params.storage = params.storage.map(() => ({ itemId: 0, localRole: 0, remoteRole: 0, max: 0, lockAmount: 0 }));
    st.items.forEach((it, i) => {
      // 翘曲器格（左栏「物流站格子」）：本地仓储、星际需求，站自己的运输船用；上限 1000（用户 2026/10/07）
      if (it.role === 'warper') {
        params.storage[i] = { itemId: it.itemId, localRole: 0, remoteRole: 2, max: 1000, lockAmount: 0 };
        return;
      }
      const role = it.role === 'supply' ? 1 : 2;
      // 喷涂用的增产剂（需求）上限 1000（用户 2026/10/07），别的物品 5000
      const max = role === 2 && SPRAY_ITEMS.has(realItem(it.itemId)) ? 1000 : 5000;
      params.storage[i] = { itemId: realItem(it.itemId), localRole: role, remoteRole: role, max, lockAmount: 0 };
    });
    params.slots = params.slots.map(() => ({ dir: 0, storageIdx: 0 }));
    for (const p of st.ports) params.slots[p.slot] = { dir: p.dir === 'out' ? 1 : 2, storageIdx: st.items.findIndex((it) => realItem(it.itemId) === realItem(p.itemId)) + 1 };
    params.pilerCount = st.stack ?? 1;
    b.parameters = params;
    stationB.push(add(b));
  }
  // ---------- 传送带 ----------
  const beltAt = new Map(); // "x,y,z" -> 建筑
  const key = (x, y, z) => `${x},${y},${z}`;
  const dirOf = (dx, dy) => (dx > 0 ? 'E' : dx < 0 ? 'W' : dy > 0 ? 'N' : 'S');
  // 出蓝图不抛错：重叠或不相邻的地方把带子断开，记一条问题，照常出图（独立检查会把问题列出来）
  const issues = [];
  const adjacent = ([x, y, z], [x1, y1, z1]) => {
    const flat = Math.abs(x1 - x) + Math.abs(y1 - y);
    return flat === 1 || (flat === 0 && Math.abs(z1 - z) === 1);
  };
  /** 按顺序建一串带子并首尾相连；遇到已占用的格子或断开的地方分成几段 */
  const build = (tiles) => {
    const runs = [];
    let cur = [];
    const taken = new Set();
    for (const t of tiles) {
      const k = key(...t);
      if (beltAt.has(k) || taken.has(k)) {
        issues.push(`传送带重叠于 (${t.join(',')})，已在此断开`);
        if (cur.length) runs.push(cur);
        cur = [];
        continue;
      }
      if (cur.length && !adjacent(cur[cur.length - 1], t)) {
        issues.push(`传送带在 (${cur[cur.length - 1].join(',')})→(${t.join(',')}) 不相邻，已在此断开`);
        runs.push(cur);
        cur = [];
      }
      taken.add(k);
      cur.push(t);
    }
    if (cur.length) runs.push(cur);
    return runs.flatMap((r) => buildRun(r));
  };
  const buildRun = (tiles) => {
    const bs = tiles.map(([x, y, z]) => {
      const k = key(x, y, z);
      const b = fresh(beltId);
      b.localOffset = at(x, y, z);
      b.parameters = null;
      beltAt.set(k, add(b));
      return b;
    });
    const n = tiles.length;
    for (let i = 0; i < n; i++) {
      const [x, y] = tiles[i];
      if (i + 1 < n) {
        bs[i].outputObjIdx = bs[i + 1].index;
        bs[i].outputToSlot = 1;
      } else {
        bs[i].outputObjIdx = -1;
      }
      // 朝向：往后找第一格换了位置的方向；到链尾就沿用前一段的方向
      let dir = null;
      for (let j = i + 1; j < n; j++) {
        if (tiles[j][0] !== x || tiles[j][1] !== y) {
          dir = dirOf(tiles[j][0] - tiles[j - 1][0], tiles[j][1] - tiles[j - 1][1]);
          break;
        }
      }
      if (!dir) {
        for (let j = i - 1; j >= 0; j--) {
          if (tiles[j][0] !== x || tiles[j][1] !== y) {
            dir = dirOf(x - tiles[j][0], y - tiles[j][1]);
            break;
          }
        }
      }
      bs[i].yaw = [HEADING[dir ?? 'E'], HEADING[dir ?? 'E']];
    }
    // 垂直升降：同一格的一叠带子（官方写法）。u 是「来路」方向：从这一叠指回前一格；一叠在链头时取去路的反方向
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && tiles[j + 1][0] === tiles[i][0] && tiles[j + 1][1] === tiles[i][1]) j++;
      if (j > i) {
        const unit = (from, to) => [Math.sign(to[0] - from[0]), Math.sign(to[1] - from[1])];
        const u = i > 0 ? unit(tiles[i], tiles[i - 1]) : j + 1 < n ? unit(tiles[j + 1], tiles[j]) : [0, 0];
        for (let m = i; m <= j; m++) {
          const k = j - m; // 还剩几节到出口
          if (!k) continue;
          const p = bs[m].localOffset[0];
          p.x = Math.round((p.x + u[0] * k * LIFT_SHIFT) * 1e4) / 1e4;
          p.y = Math.round((p.y + u[1] * k * LIFT_SHIFT) * 1e4) / 1e4;
          bs[m].localOffset[1] = { ...p };
        }
      }
      i = j + 1;
    }
    return bs;
  };
  const label = (b, itemId, rate) => (b.parameters = { iconId: realItem(itemId), count: Math.round(rate) });
  for (const chain of layout.chains) {
    const { main, extra, inPort, outPort, inStation, outStation } = chainTiles(layout, chain);
    const bs = build(main);
    if (inStation) {
      bs[0].inputObjIdx = stationB[inStation.k].index;
      bs[0].inputFromSlot = inStation.slot;
    }
    if (outStation) {
      const last = bs[bs.length - 1];
      last.outputObjIdx = stationB[outStation.k].index;
      last.outputToSlot = outStation.slot;
    }
    for (const t of extra) build(t);
    const f = graph.items.get(chain.itemId);
    if (inPort) label(bs[0], chain.itemId, f.rate); // 原料入口贴物品标签
    if (outPort) label(bs[bs.length - 1], chain.itemId, f.consumers.filter((c) => c.to === 'OUT').reduce((a, c) => a + c.rate, 0)); // 成品出口
  }

  // ---------- 翘曲器带（plan/stations.js 的 linkWarpers）：从存翘曲器那座站的出站口到别的站的进站口 ----------
  for (const w of layout.warperLinks || []) {
    const bs = build(w.cells);
    if (!bs.length) continue;
    bs[0].inputObjIdx = stationB[w.from.k].index;
    bs[0].inputFromSlot = w.from.slot;
    const last = bs[bs.length - 1];
    last.outputObjIdx = stationB[w.to.k].index;
    last.outputToSlot = w.to.slot;
  }

  // ---------- 增产剂带（可能几条）、喷涂机、自动集装机（plan/addons.js 的摆法） ----------
  for (const pl of layout.proLines || []) {
    const bs = build(pl.cells);
    if (!bs.length) continue;
    if (pl.station) {
      bs[0].inputObjIdx = stationB[pl.station.k].index;
      bs[0].inputFromSlot = pl.station.slot;
    }
    label(bs[0], pl.itemId, pl.rate ?? 0);
  }
  for (const c of layout.coaters || []) {
    const b = fresh(2313);
    b.localOffset = at(c.x, c.y, 0);
    const yaw = coaterYaw(c.ix - c.x, c.iy - c.y);
    b.yaw = [yaw, yaw];
    b.parameters = null;
    add(b);
  }
  // 集装机那一格拆成两节带子：进的一节往来路偏 0.2 格接 1 号口，出的一节往去路偏 0.2 格从 0 号口出
  const PILE_SHIFT = 0.199;
  for (const p of layout.pilers || []) {
    const mid = beltAt.get(key(p.x, p.y, 0));
    if (!mid) {
      issues.push(`自动集装机在 (${p.x},${p.y}) 找不到传送带，已略过`);
      continue;
    }
    const next = mid.outputObjIdx;
    const nextSlot = mid.outputToSlot;
    const pl = fresh(2040);
    pl.localOffset = at(p.x, p.y, 0);
    const yaw = HEADING[dirOf(p.dx, p.dy)];
    pl.yaw = [yaw, yaw];
    add(pl);
    mid.localOffset = at(p.x - PILE_SHIFT * p.dx, p.y - PILE_SHIFT * p.dy, 0);
    mid.outputObjIdx = pl.index;
    mid.outputToSlot = 1;
    const ob = fresh(beltId);
    ob.localOffset = at(p.x + PILE_SHIFT * p.dx, p.y + PILE_SHIFT * p.dy, 0);
    ob.yaw = [...mid.yaw];
    ob.parameters = null;
    ob.inputObjIdx = pl.index;
    ob.inputFromSlot = 0;
    ob.outputObjIdx = next;
    ob.outputToSlot = next >= 0 ? nextSlot : 0;
    add(ob);
  }

  // ---------- 分拣器 ----------
  for (const s of layout.sorterList) {
    const p = layout.pos.get(s.bid);
    const seg = layout.segments[s.segId];
    const cy = layout.rowCy[p.row];
    const factoryB = factoryOf.get(`${s.bid}#${s.building}`);
    const beltB = beltAt.get(key(s.col, seg.y, 0));
    if (!beltB) {
      issues.push(`${p.g.item}#${s.building} 的分拣器在 (${s.col},${seg.y}) 找不到传送带，已略过`);
      continue;
    }
    // 分拣器在工厂一端的落点：熔炉、制造台中心 ±1；化工厂下侧中心 −1 再往上挪 0.284，上侧中心 +2；
    // 研究站、对撞机的槽位不在整格上（x ±0.8 这类、y ±1.83），整根分拣器对齐到槽位的 x，带子那头接最近那格
    const pt = slotPoint(p.g, s.side, s.col - s.cx);
    const slot = pt.slot;
    const so = fresh(sorterId);
    const beltPt = { x: s.cx + pt.dx + ox, y: seg.y + oy, z: 0 };
    const edgePt = { x: s.cx + pt.dx + ox, y: cy + pt.dy + oy, z: 0 };
    if (s.io === 'in') {
      so.localOffset = [beltPt, edgePt];
      so.inputObjIdx = beltB.index;
      so.inputFromSlot = -1;
      so.outputObjIdx = factoryB.index;
      so.outputToSlot = slot;
      so.filterId = 0;
    } else {
      so.localOffset = [edgePt, beltPt];
      so.inputObjIdx = factoryB.index;
      so.inputFromSlot = slot;
      so.outputObjIdx = beltB.index;
      so.outputToSlot = -1;
      so.filterId = realItem(s.itemId); // 出料按物品过滤：有副产物的工厂两根出料分拣器各拿各的
    }
    const up = so.localOffset[1].y > so.localOffset[0].y;
    so.yaw = up ? [0, 0] : [180, 180];
    so.parameters = { length: s.length };
    add(so);
  }

  // ---------- 就地烧副产物的火力发电厂（plan/burn.js），摆法和分拣器照用户的蓝图 ----------
  for (const bank of layout.burners || []) {
    const plantB = bank.plants.map(([x, y]) => {
      const b = fresh(THERMAL_PLANT);
      b.localOffset = at(x, y);
      return add(b);
    });
    for (const s of bankSorters(bank)) {
      const so = fresh(2014); // 集装分拣器（蓝图里用的就是它）
      so.localOffset = [{ x: s.p0[0] + ox, y: s.p0[1] + oy, z: 0 }, { x: s.p1[0] + ox, y: s.p1[1] + oy, z: 0 }];
      so.yaw = [180, 180];
      so.parameters = { length: 1 };
      so.filterId = 0;
      so.outputObjIdx = plantB[s.to].index;
      so.outputToSlot = s.toSlot;
      so.inputToSlot = 1;
      so.outputFromSlot = 0;
      if (s.from === 'belt') {
        const beltB = beltAt.get(key(s.beltX, bank.feedY, 0));
        if (!beltB) {
          issues.push(`火力发电厂的进料分拣器在 (${s.beltX},${bank.feedY}) 找不到传送带，已略过`);
          continue;
        }
        so.inputObjIdx = beltB.index;
        so.inputFromSlot = -1;
      } else {
        so.inputObjIdx = plantB[s.from].index;
        so.inputFromSlot = s.fromSlot;
        so.inputOffset = 56; // 蓝图里发电厂之间的分拣器就是这个值
      }
      add(so);
    }
  }

  // ---------- 供电 ----------
  if (layout.power) {
    for (const n of layout.power.nodes) {
      const b = fresh(2201); // 电力感应塔模板；卫星配电站换物品和模型编号
      b.itemId = layout.power.itemId;
      b.modelIndex = layout.power.model;
      b.localOffset = at(n.x, n.y);
      b.yaw = [0, 0];
      b.parameters = null;
      add(b);
    }
  }

  const size = { x: layout.width, y: layout.height };
  const bp = {
    header: {
      layout: 10,
      icons: [...(opt.icons ?? [opt.targetId ?? 0]).slice(0, 5), 0, 0, 0, 0, 0].slice(0, 5), // 游戏蓝图最多 5 个图标：多目标时依次放各个目标
      time: new Date(),
      gameVersion: GAME_VERSION,
      shortDesc: opt.title ?? '手搓产线',
      desc: opt.desc ?? '',
    },
    version: 1,
    cursorOffset: { x: Math.floor(size.x / 2), y: Math.floor(size.y / 2) },
    cursorTargetArea: 0,
    dragBoxSize: size,
    primaryAreaIdx: 0,
    areas: [{ index: 0, parentIndex: -1, tropicAnchor: 0, areaSegments: 200, anchorLocalOffset: { x: 0, y: 0 }, size }],
    buildings,
  };
  // 竖排：在横排的坐标系里排好、出好，最后整张顺时针转 90°（和游戏里贴图时转一下一样）
  if (layout.rotated) rotateBlueprint(bp);
  return { blueprint: bp, str: toStr(bp), issues };
}
