// 布局校验：不依赖布线器的内部记账，从结果本身重新检查几何与连通约束。
// errors 表示布局一定有问题；warnings 表示需要留意的风险。
import { chainTiles } from '../emit/blueprint.js';
import { occupancy } from './power.js';
import { RAMP_MAX_DZ } from '../gamedata.js';

export function validate(graph, layout) {
  const errors = [];
  const warnings = [];
  const occ = new Map(); // "x,y,z" -> 描述
  const claim = (x, y, z, what) => {
    const k = `${x},${y},${z}`;
    if (occ.has(k)) errors.push(`格子 (${x},${y},${z}) 同时被「${occ.get(k)}」和「${what}」占用`);
    else occ.set(k, what);
  };
  const factoryCell = new Set();

  // 工厂本体（熔炉、制造台 3×3，化工厂 9×4；同一块里相邻两台化工厂共用中间那半格；高架带也不能从工厂上方经过）
  layout.rows.forEach((row, r) => {
    const cy = layout.rowCy[r];
    for (const bid of row) {
      const p = layout.pos.get(bid);
      const hw = (p.g.bodyWidth - 1) / 2;
      const mine = new Set();
      p.centers.forEach((cx, i) => {
        for (let x = cx - hw; x <= cx + hw; x++) {
          for (let y = cy - p.g.bodyBelow; y <= cy + p.g.bodyAbove; y++) {
            const k = `${x},${y}`;
            if (mine.has(k)) continue;
            mine.add(k);
            claim(x, y, 0, `${p.g.item}#${i}`);
            factoryCell.add(k);
          }
        }
      });
    }
  });
  // 物流站 7×7：地面除了站口那两节短带都归站；高架带不能从站上方经过
  const stationCell = new Set();
  const stubCells = new Set(layout.legs.flatMap((l) => (l.stub || []).map(([x, y]) => `${x},${y}`)));
  for (const st of layout.stations || []) {
    for (let dx = -3; dx <= 3; dx++)
      for (let dy = -3; dy <= 3; dy++) {
        const k = `${st.x + dx},${st.y + dy}`;
        stationCell.add(k);
        if (!stubCells.has(k)) claim(st.x + dx, st.y + dy, 0, '物流站');
      }
  }
  // 传送带：每种物品一条链，逐格相邻，不出界，不压工厂
  for (const chain of layout.chains) {
    const name = graph.items.get(chain.itemId).name;
    const { main, extra } = chainTiles(layout, chain);
    for (const tiles of [main, ...extra]) {
      tiles.forEach(([x, y, z], i) => {
        claim(x, y, z, `${name}带`);
        if (z > 0 && factoryCell.has(`${x},${y}`)) errors.push(`${name}高架带从工厂上方 (${x},${y}) 经过`);
        if (z > 0 && stationCell.has(`${x},${y}`)) errors.push(`${name}高架带从物流站上方 (${x},${y}) 经过`);
        if (x < 0 || x >= layout.width || y < 0 || y >= layout.height) errors.push(`${name}带超出蓝图范围 (${x},${y})`);
        const n = tiles[i + 1];
        // 相邻：水平走一格（高度变化不超过 RAMP_MAX_DZ 层；现在是 0，即不用斜坡），或者同一格里上下差一层（原地竖直升降）
        const flat = n ? Math.abs(n[0] - x) + Math.abs(n[1] - y) : 1;
        if (n && !(flat === 1 || (flat === 0 && Math.abs(n[2] - z) === 1))) errors.push(`${name}带在 (${x},${y},${z}) 处断开`);
        else if (n && flat === 1 && Math.abs(n[2] - z) > RAMP_MAX_DZ) errors.push(`${name}带在 (${x},${y},${z}) 处斜着升降 ${Math.abs(n[2] - z)} 层（升降应在同一格里竖直叠放）`);
      });
    }
  }

  // 每个块的每种输入、输出都必须有一段同物品的地面带，位于相邻通道、覆盖全部工厂、且在分拣器够得着的距离内
  const reach = (p, seg) => {
    const cy = layout.rowCy[p.row];
    if (seg.ch === p.row) return cy - p.g.edgeBelow - seg.y; // 从分拣器在工厂一端的落点到轨道
    if (seg.ch === p.row + 1) return seg.y - (cy + p.g.edgeAbove);
    return Infinity;
  };
  const covers = (p, seg) => p.centers.every((c) => seg.a <= c + (p.g.tap ?? 0) + 1 && seg.b >= c + (p.g.tap ?? 0) - 1);
  for (const p of layout.pos.values()) {
    const need = [...p.g.inputs.map((id) => ({ id, io: 'in' })), ...(p.g.outputs ?? [{ itemId: p.g.itemId }]).map((o) => ({ id: o.itemId, io: 'out' }))];
    for (const n of need) {
      const segs = layout.segments.filter((s) => s.itemId === n.id && reach(p, s) <= 3 && covers(p, s));
      if (!segs.length) errors.push(`${p.g.item}（块 ${p.bid}）的${n.io === 'in' ? '输入' : '输出'}「${graph.items.get(n.id).name}」没有可接的带`);
    }
  }

  // 逐根检查已落位的分拣器：列在工厂可用范围内且落在所接的带上，长度 1~3，同一通道同一列的分拣器不接同一格带子
  const segById = new Map(layout.segments.map((s) => [s.id, s]));
  const spans = new Map(); // "通道|列" -> [{who}]
  for (const s of layout.sorterList || []) {
    const p = layout.pos.get(s.bid);
    const seg = segById.get(s.segId);
    const who = `${p.g.item}#${s.building}${s.side === 'top' ? '上' : '下'}侧「${graph.items.get(s.itemId).name}」`;
    if (!seg) {
      errors.push(`${who} 分拣器没有对应的带`);
      continue;
    }
    if (p.g.slots?.[s.side]?.[s.col - s.cx] == null) errors.push(`${who} 分拣器列 ${s.col} 不在工厂边上（没有对应的槽位）`);
    if (s.col < seg.a || s.col > seg.b) errors.push(`${who} 分拣器列 ${s.col} 不在带的范围 [${seg.a},${seg.b}] 内`);
    const len = reach(p, seg);
    if (len !== s.length || len < 1 || len > 3) errors.push(`${who} 分拣器长度 ${s.length}（几何上为 ${len}）不合法`);
    // 碰撞规则：同一通道同一列的两根分拣器，只有接到同一格带子或交叉时才碰撞。
    // 下方行伸上来的（工厂上侧）占轨道 0..track，上方行伸下来的占 track..n-1，两段不能有公共格。
    const k = `${seg.ch}|${s.col}`;
    if (!spans.has(k)) spans.set(k, []);
    const fromBelow = s.side === 'top';
    for (const o of spans.get(k)) {
      const ok = fromBelow !== o.fromBelow && (fromBelow ? seg.track < o.track : o.track < seg.track);
      if (!ok) errors.push(`${who} 与 ${o.who} 在通道${seg.ch} 第 ${s.col} 列相对，会碰撞`);
    }
    spans.get(k).push({ who, fromBelow, track: seg.track });
  }
  // 供电：设施不压任何东西、不出界，所有工厂和分拣器都在某个设施的覆盖范围内
  if (layout.power) {
    const P = layout.power;
    const { occ, targets } = occupancy(layout, { ...layout.power.options, power: P.itemId });
    const h = (P.size - 1) / 2;
    for (const n of P.nodes)
      for (let dx = -h; dx <= h; dx++)
        for (let dy = -h; dy <= h; dy++) {
          const x = n.x + dx;
          const y = n.y + dy;
          if (occ.has(`${x},${y}`)) errors.push(`${P.name} (${n.x},${n.y}) 压在 (${x},${y}) 的建筑或带子上`);
          const e = P.extend;
          if (x < -e.left || y < -e.bottom || x >= layout.width - e.left || y >= layout.height - e.bottom) errors.push(`${P.name} (${n.x},${n.y}) 出界`);
        }
    const r2 = P.cover * P.cover;
    const miss = targets.filter((t) => !P.nodes.some((n) => (n.x - t.x) ** 2 + (n.y - t.y) ** 2 <= r2));
    if (miss.length) warnings.push(`${miss.length} 个工厂/分拣器不在${P.name}覆盖范围内（如 ${miss[0].what} @ ${miss[0].x},${miss[0].y}）`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
