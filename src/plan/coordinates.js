// 布局平移统一入口。坐标只在这里改写，避免物流站、分拣器或带子漏移。
export function translateLayout(L, dx, dy) {
  const points = (a) => { for (const p of a || []) { p[0] += dx; p[1] += dy; } };
  L.rowCy = L.rowCy.map((y) => y + dy);
  for (const p of L.pos.values()) {
    for (const k of ['x0', 'x1', 'tmin', 'tmax']) p[k] += dx;
    p.centers = p.centers.map((x) => x + dx);
  }
  for (const c of L.channels) c.base += dy;
  for (const s of L.segments) {
    for (const k of ['a', 'b', 'entryX', 'exitX', 'split', 'gapX']) if (s[k] != null) s[k] += dx;
    s.y += dy;
  }
  for (const l of L.legs) {
    for (const k of ['edge', 'xv']) if (l[k] != null) l[k] += dx;
    if (l.py != null) l.py += dy;
    points(l.cells);
    points(l.stub);
    points(l.pre);
  }
  for (const p of L.ports) { p.x += dx; p.y += dy; }
  for (const s of L.sorterList) { s.col += dx; s.cx += dx; }
  for (const s of L.stations || []) { s.x += dx; s.y += dy; }
  for (const p of L.power?.nodes || []) { p.x += dx; p.y += dy; }
  L.streets = (L.streets || []).map((x) => x + dx);
  for (const p of L.pilers || []) { p.x += dx; p.y += dy; }
  for (const c of L.coaters || []) { c.x += dx; c.y += dy; c.ix += dx; c.iy += dy; }
  for (const pl of L.proLines || []) { points(pl.cells); if (pl.edge) { pl.edge[0] += dx; pl.edge[1] += dy; } }
  for (const w of L.warperLinks || []) points(w.cells);
  // 就地烧副产物的火力发电厂（plan/burn.js）
  for (const b of L.burners || []) {
    points(b.plants);
    points(b.feed);
    points([b.gate]);
    b.rect = [b.rect[0] + dx, b.rect[1] + dy, b.rect[2] + dx, b.rect[3] + dy];
    b.feedY += dy;
  }
  return L;
}
