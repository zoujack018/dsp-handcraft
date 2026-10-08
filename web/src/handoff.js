// 从别的网页跳过来时带的方案：地址里的 #plan=（URI 编码的 JSON），字段都按游戏 ID。
// 用在「戴森球计划量产量化计算器」（DSQ，github.com/122474363/DSQ）的生成蓝图页：那边点「生成蓝图」时把需求、选的配方、设备、
// 排除的物品带过来，这边填好、自动排一次。
//   targets: [{ id: 物品 ID, rate: 每分钟 }]            必填
//   ext: [物品 ID]                                      外部供应
//   recipes: { 物品 ID: 配方 ID }                        指定配方
//   assembler / smelter / chemical / lab: 建筑 ID；belt: 1~3；sorter: 分拣器 ID；pile: 物流站出货叠几层 1~4；labstack: 1~15
//   auto: 到了就自动生成一次（默认是）
//   from: 来源网页的名字（页面上显示「从 xx 带过来的方案」）

const OPTION_KEYS = ['assembler', 'smelter', 'chemical', 'lab', 'belt', 'sorter', 'pile'];

/** 解析地址里的 #plan=，没有或格式不对返回 null */
export function readHandoff(hash) {
  const m = /(?:^#|&)plan=([^&]*)/.exec(hash || '');
  if (!m) return null;
  let p;
  try {
    p = JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object') return null;
  const targets = (Array.isArray(p.targets) ? p.targets : []).map((t) => ({ id: Number(t?.id), rate: Number(t?.rate) })).filter((t) => t.id > 0 && t.rate > 0);
  if (!targets.length) return null;
  const ext = [...new Set((Array.isArray(p.ext) ? p.ext : []).map(Number).filter((x) => x > 0))];
  const recipes = {};
  for (const [k, v] of Object.entries(p.recipes && typeof p.recipes === 'object' ? p.recipes : {})) if (Number(k) > 0 && Number(v) > 0) recipes[Number(k)] = Number(v);
  const options = {};
  for (const k of OPTION_KEYS) if (p[k] != null && p[k] !== '') options[k] = String(p[k]);
  const labstack = Number(p.labstack) > 0 ? Number(p.labstack) : null;
  return { targets, ext, recipes, options, labstack, auto: p.auto !== false, from: typeof p.from === 'string' ? p.from.slice(0, 40) : null };
}

/** 生成 #plan= 地址片段（给别的网页用，也方便测试） */
export function handoffHash(plan) {
  return `#plan=${encodeURIComponent(JSON.stringify(plan))}`;
}
