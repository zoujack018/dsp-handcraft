// 物品图示：本项目自绘的简单线条图形（不是游戏图标），按物品名称和类别归到二十多种通用形状。
// 每个图形是 24×24 的 SVG symbol，描边用 currentColor，填充用 --fill（类别色或矩阵色）。

const S = (id, body) => `<symbol id="g-${id}" viewBox="0 0 24 24">${body}</symbol>`;
const F = 'fill="var(--fill)" fill-opacity="0.35"';

export const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true"><defs>
${S('ore', `<path d="M4 15l3-7 6-3 6 4 1 7-5 4H8z" ${F}/><path d="M7 8l4 5 2-8M11 13l9 3M11 13l-3 6"/>`)}
${S('ingot', `<path d="M3 15l4-6h14l-4 6z" ${F}/><path d="M3 15v3h14l4-6v-3M17 15v3"/>`)}
${S('beam', `<path d="M5 5h14v3h-5v8h5v3H5v-3h5V8H5z" ${F}/>`)}
${S('block', `<path d="M4 9l8-4 8 4v7l-8 4-8-4z" ${F}/><path d="M4 9l8 4 8-4M12 13v7"/>`)}
${S('sheet', `<path d="M3 14l6-5h12l-6 5z" ${F}/><path d="M3 17l6-5M15 17l6-5M3 17h12M3 14v3M15 14v3"/><path d="M8 12l3-2" stroke-opacity="0.6"/>`)}
${S('crystal', `<path d="M12 3l6 6-6 12-6-12z" ${F}/><path d="M6 9h12M12 3l-2 6 2 12 2-12z"/>`)}
${S('drop', `<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z" ${F}/><path d="M9.5 14a2.5 2.5 0 0 0 2.5 2.5" stroke-opacity="0.7"/>`)}
${S('atom', `<circle cx="12" cy="12" r="3" ${F}/><ellipse cx="12" cy="12" rx="9" ry="4"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)"/>`)}
${S('spark', `<path d="M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" ${F}/>`)}
${S('magnet', `<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z" ${F}/><path d="M6 8h4M14 8h4"/>`)}
${S('coil', `<path d="M4 12h2M18 12h2"/><ellipse cx="9" cy="12" rx="2.5" ry="6" ${F}/><ellipse cx="12" cy="12" rx="2.5" ry="6"/><ellipse cx="15" cy="12" rx="2.5" ry="6"/>`)}
${S('gear', `<path d="M10.5 3h3l.5 2.6 2.2 1 2.2-1.5 2.1 2.1-1.5 2.2 1 2.2 2.6.5v3l-2.6.5-1 2.2 1.5 2.2-2.1 2.1-2.2-1.5-2.2 1-.5 2.6h-3l-.5-2.6-2.2-1-2.2 1.5-2.1-2.1 1.5-2.2-1-2.2L2.4 13.5v-3l2.6-.5 1-2.2-1.5-2.2 2.1-2.1 2.2 1.5 2.2-1z" ${F}/><circle cx="12" cy="12" r="3"/>`)}
${S('chip', `<rect x="6" y="6" width="12" height="12" rx="1" ${F}/><rect x="9" y="9" width="6" height="6"/><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/>`)}
${S('board', `<rect x="3" y="5" width="18" height="14" rx="1" ${F}/><path d="M6 9h5l2 3h5M6 15h4l2-3M15 16h3"/><circle cx="6" cy="9" r="0.8"/><circle cx="18" cy="12" r="0.8"/>`)}
${S('motor', `<rect x="4" y="7" width="12" height="10" rx="2" ${F}/><path d="M16 12h5M7 7v10M10 7v10M13 7v10M6 17v3h8v-3"/>`)}
${S('fan', `<circle cx="12" cy="12" r="9" ${F}/><path d="M12 12c0-4 2-6 4-6M12 12c4 0 6 2 6 4M12 12c0 4-2 6-4 6M12 12c-4 0-6-2-6-4"/><circle cx="12" cy="12" r="1.5"/>`)}
${S('prism', `<path d="M12 4l8 15H4z" ${F}/><path d="M12 4l-2 15" stroke-opacity="0.6"/><path d="M1 12h6M17 11l6-2M17 13l6 1"/>`)}
${S('lens', `<path d="M12 3c4 3 4 15 0 18c-4-3-4-15 0-18z" ${F}/><path d="M3 12h4M17 12h4"/>`)}
${S('hex', `<path d="M8 4h4l2 3.5L12 11H8L6 7.5zM14 7.5h4l2 3.5-2 3.5h-4l-2-3.5M8 11h4l2 3.5-2 3.5H8l-2-3.5z" ${F}/>`)}
${S('tube', `<path d="M6 7h12v10H6z" ${F}/><ellipse cx="6" cy="12" rx="2" ry="5"/><path d="M9 7v10M12 7v10M15 7v10" stroke-opacity="0.6"/>`)}
${S('rod', `<rect x="9" y="2" width="6" height="20" rx="3" ${F}/><path d="M9 7h6M9 17h6"/>`)}
${S('capsule', `<path d="M7 7h10v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" ${F}/><path d="M9 3h6v4H9zM7 12h10"/>`)}
${S('sphere', `<circle cx="12" cy="12" r="8" ${F}/><ellipse cx="12" cy="12" rx="8" ry="3"/><path d="M12 4v16" stroke-opacity="0.5"/>`)}
${S('cube', `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="var(--fill)" fill-opacity="0.75"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>`)}
${S('frame', `<rect x="4" y="4" width="16" height="16" ${F}/><path d="M4 4l16 16M20 4L4 20M12 4v16M4 12h16" stroke-opacity="0.7"/>`)}
${S('sail', `<path d="M12 3l8 16H4z" ${F}/><path d="M12 3v16M8 11h8M6 15h12" stroke-opacity="0.6"/>`)}
${S('rocket', `<path d="M12 2c3 3 4 7 4 11v5H8v-5c0-4 1-8 4-11z" ${F}/><path d="M8 14l-3 4v3l3-2M16 14l3 4v3l-3-2M10 18v3M14 18v3"/><circle cx="12" cy="9" r="1.5"/>`)}
${S('engine', `<path d="M4 8h8l6-3v14l-6-3H4z" ${F}/><path d="M18 9h3M18 15h3M8 8v8"/>`)}
${S('ammo', `<path d="M8 21V10c0-3 2-6 4-7 2 1 4 4 4 7v11z" ${F}/><path d="M8 15h8"/>`)}
${S('blast', `<path d="M12 3l2 5 5-2-2 5 5 2-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-2-2-5 5 2z" ${F}/>`)}
${S('craft', `<path d="M2 13l9-2 7-6 2 1-3 6 5 1v2l-5 1 3 6-2 1-7-6-9-2z" ${F}/>`)}
${S('warp', `<circle cx="12" cy="12" r="9" ${F}/><path d="M12 12a1.5 1.5 0 0 1 3 0 3.5 3.5 0 0 1-7 0 5.5 5.5 0 0 1 11 0"/>`)}
${S('wave', `<rect x="2" y="5" width="20" height="14" rx="2" ${F} stroke="none"/><path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 4-4 5-2"/><path d="M2 16c2.5-4 5-4 7.5 0s5 4 7.5 0" stroke-opacity="0.6"/>`)}
${S('slab', `<rect x="3" y="8" width="18" height="8" rx="4" ${F}/><path d="M7 12h10" stroke-opacity="0.6"/>`)}
${S('flask', `<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/><path d="M7.5 15h9l2 3.5a1 1 0 0 1-1 1.5H6.5a1 1 0 0 1-1-1.5z" ${F}/>`)}
${S('leaf', `<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15z" ${F}/><path d="M5 19l9-9"/>`)}
${S('shard', `<path d="M6 4l5 3-2 6 4 7-8-5z" ${F}/><path d="M14 3l5 5-3 4 2 8-6-9z" ${F}/>`)}
${S('building', `<path d="M3 20V10l5 3V10l5 3V6h4v14z" ${F}/><path d="M3 20h18M17 6h3v14"/>`)}
${S('belt', `<rect x="2" y="8" width="20" height="8" rx="1" ${F}/><path d="M6 10l2 2-2 2M11 10l2 2-2 2M16 10l2 2-2 2"/>`)}
${S('arm', `<path d="M4 20h7M7 20v-6l6-6 4 3" /><circle cx="7" cy="14" r="1.5" ${F}/><circle cx="13" cy="8" r="1.5" ${F}/><path d="M17 11l3-2M17 11l2 3"/>`)}
${S('pole', `<path d="M12 3v18M8 21h8M7 7h10M9 11h6"/><circle cx="12" cy="4" r="1.5" ${F}/>`)}
${S('turret', `<path d="M5 20l2-6h10l2 6z" ${F}/><rect x="8" y="9" width="8" height="5" rx="1" ${F}/><path d="M14 11l7-3"/>`)}
${S('box', `<rect x="4" y="6" width="16" height="14" rx="1" ${F}/><path d="M4 10h16M10 13h4"/>`)}
${S('station', `<path d="M5 20v-8h14v8z" ${F}/><path d="M12 12V4M8 6h8M3 20h18M9 16h6"/>`)}
${S('bolt', `<path d="M13 2L5 14h6l-2 8 10-13h-6z" ${F}/>`)}
${S('dot', `<rect x="5" y="5" width="14" height="14" rx="3" ${F}/><circle cx="12" cy="12" r="2.5"/>`)}
</defs></svg>`;

const MATRIX = { 电磁矩阵: '#4a8fe7', 能量矩阵: '#e5534b', 结构矩阵: '#e3b341', 信息矩阵: '#9b6ee8', 引力矩阵: '#4fb36b', 宇宙矩阵: '#e8edf5', 黑雾矩阵: '#55595f' };
const CAT_COLOR = { 1: '#8d99a6', 2: '#6f8fb3', 3: '#5f9b8b', 4: '#b48b52', 5: '#7c80c0', 6: '#4f7cc9', 8: '#b56262', 9: '#b56262', 10: '#707070', 11: '#9a72cf' };

// 先按完整名称，再按关键字，最后按类别
const EXACT = {
  磁铁: 'magnet', 单极磁石: 'magnet', 钢材: 'beam', 石材: 'block', 地基: 'frame', 框架材料: 'frame', 玻璃: 'sheet', 钛化玻璃: 'sheet',
  水: 'drop', 原油: 'drop', 精炼油: 'drop', 硫酸: 'drop', 氢: 'atom', 重氢: 'atom', 反物质: 'atom', 核心素: 'atom', 临界光子: 'spark', 奇异物质: 'spark', 负熵奇点: 'spark',
  磁线圈: 'coil', 超级磁场环: 'coil', 齿轮: 'gear', 电路板: 'board', 位面过滤器: 'board', 电动机: 'motor', 电磁涡轮: 'fan', 棱镜: 'prism', 光子合并器: 'prism', 引力透镜: 'lens',
  石墨烯: 'hex', 碳纳米管: 'tube', 粒子宽带: 'wave', 粒子容器: 'capsule', 湮灭约束球: 'sphere', 戴森球组件: 'sphere', 太阳帆: 'sail', 小型运载火箭: 'rocket', 空间翘曲器: 'warp',
  塑料: 'slab', 动力引擎: 'engine', 推进器: 'engine', 加力推进器: 'engine', 木材: 'leaf', 植物燃料: 'leaf', 可燃冰: 'crystal', 能量碎片: 'shard', 硅基神经元: 'shard', 物质重组器: 'shard',
  蓄电器: 'bolt', '蓄电器（满）': 'bolt', 能量枢纽: 'bolt', 人造恒星: 'spark', 喷涂机: 'flask', 矩阵研究站: 'flask', 自演化研究站: 'flask',
};
const KEYWORD = [
  [/矿|硅石$|钛石$|光栅石|刺笋/, 'ore'],
  [/块$|钛合金|高能石墨/, 'ingot'],
  [/晶体|晶石|晶格|金刚石/, 'crystal'],
  [/芯片|处理器|元件|神经/, 'chip'],
  [/燃料棒/, 'rod'],
  [/胶囊/, 'capsule'],
  [/矩阵/, 'cube'],
  [/增产剂/, 'flask'],
  [/弹箱|炮弹|导弹/, 'ammo'],
  [/燃烧单元|爆破单元/, 'blast'],
  [/无人机|运输机|运输船|护卫舰|驱逐舰|原型机/, 'craft'],
  [/传送带|分流器|集装机|监测器/, 'belt'],
  [/分拣器/, 'arm'],
  [/电力感应塔|输电塔|配电站|信号塔/, 'pole'],
  [/发电|涡轮机|太阳能板|射线接收/, 'bolt'],
  [/储物仓|储液罐/, 'box'],
  [/物流|配送器|采集器/, 'station'],
  [/机枪塔|防御塔|加农炮|激光塔|电浆炮|电浆塔|干扰塔|护盾/, 'turret'],
];

export function glyphOf(item) {
  const name = item.name;
  let id = EXACT[name];
  if (!id) for (const [re, g] of KEYWORD) if (re.test(name)) { id = g; break; }
  if (!id) id = item.type === 6 || item.type === 5 ? 'building' : 'dot';
  const fill = MATRIX[name] || CAT_COLOR[item.type] || '#8d99a6';
  return { id, fill };
}

export function glyphSvg(item, cls = 'gl') {
  const { id, fill } = glyphOf(item);
  return `<svg class="${cls}" style="--fill:${fill}" viewBox="0 0 24 24" aria-hidden="true"><use href="#g-${id}"/></svg>`;
}
