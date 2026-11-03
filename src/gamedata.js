// 游戏数据访问层：物品、配方、工厂。全部以 ID 为主键，名称只用于显示和输入。
import vanilla from '../data/Vanilla.json' with { type: 'json' };

/** 游戏数据里制造台名称带不间断空格（ ），统一成普通空格 */
export const normName = (s) => String(s).replace(/ /g, ' ').trim();

export const ITEMS = new Map();
const ITEM_BY_NAME = new Map();
function addItem(it) {
  // power：建筑工作时的功率（瓦），游戏数据里是每 tick 的焦耳数（一秒 60 tick）
  const item = { id: it.ID, name: normName(it.Name), type: it.Type, speed: it.Speed, power: (it.WorkEnergyPerTick ?? 0) * 60 };
  ITEMS.set(item.id, item);
  return item;
}
for (const it of vanilla.items) {
  const item = addItem(it);
  ITEM_BY_NAME.set(item.name, item);
}

export const RECIPES = new Map();
const PRODUCERS = new Map(); // itemId -> recipe[]
function addRecipe(r) {
  const recipe = {
    id: r.ID,
    name: normName(r.Name),
    type: r.Type, // 1 冶炼 2 化工 3 精炼 4 制造 15 研究站 -1 黑雾掉落 ...
    factories: r.Factories,
    inputs: r.Items.map((id, i) => ({ id, count: r.ItemCounts[i] })),
    outputs: r.Results.map((id, i) => ({ id, count: r.ResultCounts[i] })),
    time: r.TimeSpend / 60, // 秒
    proliferator: r.Proliferator ?? 0, // 能不能喷增产剂：1 只能加速，3 加速或增产，0 都不行
  };
  // 同一个 ID 再登记一次（计算器带来的配方换掉自带的，见 addGameData）：「谁能产这个物品」里原地换成新的，新配方不再产的物品拿掉
  const old = RECIPES.get(recipe.id);
  RECIPES.set(recipe.id, recipe);
  if (old) for (const o of old.outputs) {
    const list = PRODUCERS.get(o.id);
    const k = list.indexOf(old);
    if (recipe.outputs.some((y) => y.id === o.id)) list[k] = recipe;
    else list.splice(k, 1);
  }
  for (const o of recipe.outputs) {
    if (!PRODUCERS.has(o.id)) PRODUCERS.set(o.id, []);
    if (!PRODUCERS.get(o.id).includes(recipe)) PRODUCERS.get(o.id).push(recipe);
  }
}
for (const r of vanilla.recipes) addRecipe(r);

/** 游戏里的原矿（物品 Type 1），默认由物流站供应 */
export const RAW_ITEM_IDS = new Set(vanilla.items.filter((i) => i.Type === 1).map((i) => i.ID));

/**
 * 补进别的网页带来的物品和配方（写法同 data/Vanilla.json，见 web/src/handoff.js 的 defs）：嵌在「量产量化计算器」里时配方以那边为准，
 * 这边没有的加进来（比如黑雾引力透镜），原料、产物、数量、时间、工厂、能不能增产有一样不同的换成那边的，全都一样的不动（原料顺序不算）。
 * 物品只加这边没有的，名字用这边的。配方的原料、产物得是认识的物品，工厂得是这边有几何的，不然不用。
 * 返回加进来的物品 ID、配方 ID，和换掉的配方 ID（replaced）。
 */
export function addGameData({ items = [], recipes = [] } = {}) {
  const added = { items: [], recipes: [], replaced: [] };
  for (const it of items) {
    if (ITEMS.has(it.ID)) continue;
    const item = addItem(it);
    if (!ITEM_BY_NAME.has(item.name)) ITEM_BY_NAME.set(item.name, item);
    added.items.push(item.id);
  }
  // 一边的原料或产物：物品 → 数量，排好序比（顺序不算）
  const side = (ids, counts) => JSON.stringify(ids.map((id, i) => [id, counts[i]]).sort((a, b) => a[0] - b[0]));
  const same = (old, r) =>
    side(old.inputs.map((x) => x.id), old.inputs.map((x) => x.count)) === side(r.Items, r.ItemCounts) &&
    side(old.outputs.map((x) => x.id), old.outputs.map((x) => x.count)) === side(r.Results, r.ResultCounts) &&
    old.time * 60 === r.TimeSpend && old.type === r.Type && old.proliferator === (r.Proliferator ?? 0) &&
    [...old.factories].sort().join() === [...r.Factories].sort().join();
  for (const r of recipes) {
    if (![...r.Items, ...r.Results].every((id) => ITEMS.has(id)) || !r.Factories.every((f) => f in FACTORY_KIND)) continue;
    const old = RECIPES.get(r.ID);
    if (old && same(old, r)) continue;
    addRecipe({ ...r, Name: r.Name || old?.name || ITEMS.get(r.Results[0]).name });
    (old ? added.replaced : added.recipes).push(r.ID);
  }
  return added;
}

export function item(idOrName) {
  if (typeof idOrName === 'number') {
    const it = ITEMS.get(idOrName);
    if (!it) throw new Error(`未知物品 ID ${idOrName}`);
    return it;
  }
  const it = ITEM_BY_NAME.get(normName(idOrName));
  if (!it) throw new Error(`未知物品「${idOrName}」`);
  return it;
}

export function recipe(idOrName) {
  if (typeof idOrName === 'number') {
    const r = RECIPES.get(idOrName);
    if (!r) throw new Error(`未知配方 ID ${idOrName}`);
    return r;
  }
  for (const r of RECIPES.values()) if (r.name === normName(idOrName)) return r;
  throw new Error(`未知配方「${idOrName}」`);
}

export const recipesProducing = (itemId) => PRODUCERS.get(itemId) || [];

/**
 * 增产剂（喷涂机喷在原料上）：等级 1~3 = Mk.I~Mk.III。
 *   extra  增产：每次多出这么多产物（原料不变）       speed  加速：工厂快这么多（原料、产物同比例）
 *   sprays 一个增产剂能喷多少个原料
 * 配方能增产（Proliferator 含 2）就按增产算，只能加速（Proliferator 1）就按加速算。数值是游戏里的标准值。
 */
export const SPRAY_LEVELS = [
  null,
  { level: 1, item: 1141, name: '增产剂 Mk.I', extra: 0.125, speed: 0.25, sprays: 12 },
  { level: 2, item: 1142, name: '增产剂 Mk.II', extra: 0.2, speed: 0.5, sprays: 24 },
  { level: 3, item: 1143, name: '增产剂 Mk.III', extra: 0.25, speed: 1, sprays: 60 },
];

/**
 * 科技「集装分拣器改良」各级（下标 = 等级，0 是没研究）给集装分拣器（2014）的：
 *   out   往带上放货叠几层（GameHistoryData.inserterStackOutput，默认 1）：1、3、5 级提到 2、3、4
 *   in    一趟最多取几份（inserterStackInput，默认 2）：2、4 级提到 3、4
 *   both  双向运送（inserterBidirectional，默认 false）：6 级
 * 来源：BWIKI「集装分拣器改良」、游戏 0.10.35 的 GameHistoryData（game-rules 第 45 条）。
 */
export const PILE_SORTER_TECH = [
  { out: 1, in: 2, both: false },
  { out: 2, in: 2, both: false },
  { out: 2, in: 3, both: false },
  { out: 3, in: 3, both: false },
  { out: 3, in: 4, both: false },
  { out: 4, in: 4, both: false },
  { out: 4, in: 4, both: true },
];

/**
 * 工厂几何（单位：格；坐标以工厂中心所在格为原点，y 向上）。
 *   pitch        同一块里相邻两台的中心距
 *   center       块左端到第一台中心的距离
 *   trailing     块宽比 台数 × pitch 多的列数（对撞机 1：补左边空的那 1 列）
 *   bodyWidth    本体占的列数（化工厂 7、对撞机 9）
 *   bodyBelow/bodyAbove  本体在中心下方/上方占几行
 *   edgeBelow/edgeAbove  分拣器在工厂一端的落点离中心几行（下侧 / 上侧）
 *   edgeShiftBelow       下侧落点再往上挪的小数（化工厂 0.284，照抄 antian 已验证的写法）
 *   slots        分拣器落在各列（相对工厂中心的偏移）时对应的槽位号；没列出的列不能接分拣器
 *   slotPos      槽位的精确位置 [dx, dy]（相对工厂中心）：研究站、对撞机的槽位不在整格上，分拣器两端都对齐到槽位的 x，
 *                接到最近那格带子（参考蓝图，game-rules 第 16 条）。没有 slotPos 的工厂按「列, ±edge」落点
 *   tap          分拣器那三列的中间一列相对工厂中心的偏移（一般是 0，对撞机是 −2：接口偏在左边）
 *   collider     独立检查用的碰撞体 [宽, 高]
 *   colliderShift  碰撞体中心相对工厂中心的偏移 [dx, dy]（化工厂往上 0.5：本体下 1 上 2；对撞机往左 0.3）
 * 熔炉 3 格、制造台 4 格的间距和化工厂的槽位都沿用 antian369 已在游戏里验证过的写法
 * （制造台实际碰撞体约 3.2×3.2，3 格间距会重叠，所以取 4）。化工厂 7、对撞机 9 是实测（game-rules 第 19 条）。
 * 同一块里相邻两台本体紧挨着。和别的块挨着（实测，game-rules 第 20、21 条）：化工厂两边紧挨熔炉、制造台都能放，块的两头不留空列；
 * 对撞机左右不对称（左边紧挨制造台不行），块左边空 1 列（center 5，块宽 9n + 1）、右边直接挨下一块。
 */
const SLOTS_3x3 = { bottom: { 1: 6, 0: 7, [-1]: 8 }, top: { [-1]: 0, 0: 1, 1: 2 } };
const BOX3 = { bodyWidth: 3, bodyBelow: 1, bodyAbove: 1, edgeBelow: 1, edgeAbove: 1, edgeShiftBelow: 0, trailing: 0, slots: SLOTS_3x3 };
const FACTORY_GEOMETRY = {
  smelter: { ...BOX3, pitch: 3, center: 1, collider: [2.4, 2.4], supported: true },
  assembler: { ...BOX3, pitch: 4, center: 2, collider: [3.2, 3.2], supported: true },
  // 化工厂：antian 的模板 area [4,2]、inserterBorder 上 2 下 1；槽位 上排左到右 0 1 2 7，下排 6 5 4 3
  chemical: {
    pitch: 7,
    center: 3,
    trailing: 0,
    bodyWidth: 7,
    bodyBelow: 1,
    bodyAbove: 2,
    edgeBelow: 1,
    edgeAbove: 2,
    edgeShiftBelow: 0.284,
    slots: { bottom: { [-1]: 6, 0: 5, 1: 4 }, top: { [-1]: 0, 0: 1, 1: 2 } },
    // 碰撞体宽 6~6.8（实测隔 7 能放、隔 6 撞；两边紧挨制造台能放，3.4 + 1.6 ≤ 5），取 6.8；上下就是本体那 4 行（站紧贴它下沿能放）
    collider: [6.8, 4],
    colliderShift: [0, 0.5],
    supported: true,
  },
  // 原油精炼厂（实测，game-rules 第 32 条）：两台中心隔 3 并排能放；北边没有口，只接下侧那条通道（长 1 的分拣器接中心下 4 格的带）。
  // 碰撞体按 2.8 × 5.6、往南偏 0.4（北到 +2.4、南到 −3.2）。卫星配电站另见 substationPad。只排等离子精炼（REFINERY_RECIPES）
  refinery: {
    pitch: 3,
    center: 1,
    trailing: 0,
    bodyWidth: 3,
    bodyBelow: 3,
    bodyAbove: 2,
    edgeBelow: 3,
    edgeAbove: 2,
    edgeShiftBelow: 0,
    slots: { bottom: { [-1]: 6, 0: 7, 1: 8 }, top: {} },
    slotPos: { 6: [-0.782, -2.866], 7: [0, -2.862], 8: [0.782, -2.866], 0: [0.88, -0.799], 1: [0.887, -0.004], 2: [0.895, 0.791], 3: [-0.895, 0.791], 4: [-0.887, -0.004], 5: [-0.88, -0.799] },
    collider: [2.8, 5.6],
    colliderShift: [0, -0.4],
    supported: true,
  },
  // 微型粒子对撞机：Buildings.json area [5, 2.5]、inserterBorder 上 2 下 2。间距 9、碰撞体按 9×5、中心往左 0.3 格
  // （实测，game-rules 第 19~21 条；偏多少是推断）。槽位上下两侧都挤在中心左边（参考蓝图，game-rules 第 16 条），
  // 分拣器两端对齐槽位的 x、接最近那格带子，所以只有 x−2、x−1 两列能接（−1.6 和 −2.4 都落在 x−2 那格，取 −1.6 那个），
  // 每侧最多 2 根，4 根正好够奇异物质（3 进 1 出）。
  collider: {
    pitch: 9,
    center: 5,
    trailing: 1,
    bodyWidth: 9,
    bodyBelow: 2,
    bodyAbove: 2,
    edgeBelow: 2,
    edgeAbove: 2,
    edgeShiftBelow: 0,
    tap: -2,
    slots: { bottom: { [-2]: 7, [-1]: 8 }, top: { [-2]: 1, [-1]: 0 } },
    // 左侧 3/4/5 号规划器不用（排成行时左右是邻居），列出来给独立检查认手搓的蓝图
    slotPos: { 0: [-0.803, 1.828], 1: [-1.605, 1.827], 2: [-2.407, 1.826], 6: [-2.401, -1.831], 7: [-1.6, -1.83], 8: [-0.8, -1.829], 3: [-3.849, 0.789], 4: [-3.847, -0.006], 5: [-3.844, -0.801] },
    collider: [9, 5],
    colliderShift: [-0.3, 0],
    supported: true,
  },
  // 研究站：Buildings.json area [3,3,3]、inserterBorder 上 2 下 2；碰撞体约 4.5×4.5（占地 20.25 开方）。
  // 间距 5（实测，game-rules 第 18 条）：本体 5 列紧挨着，相邻两台的分拣器列（中心 −1/0/+1）不重叠。
  // 槽位照参考蓝图（game-rules 第 16 条），上侧 0/1/2 号是从右到左。
  // 可以竖着叠：上面一台的 inputObjIdx 指向下面一台（inputFromSlot 15、outputToSlot 14），每层高 3（levelZ），
  // 分拣器只接最底下那台，原料往上传、产物往下传。能叠几层看「垂直建造」科技，由玩家自己填。
  lab: {
    pitch: 5,
    center: 2,
    trailing: 0,
    bodyWidth: 5,
    bodyBelow: 2,
    bodyAbove: 2,
    edgeBelow: 2,
    edgeAbove: 2,
    edgeShiftBelow: 0,
    slots: { bottom: { [-1]: 6, 0: 7, 1: 8 }, top: { 1: 0, 0: 1, [-1]: 2 } },
    slotPos: {
      ...{ 0: [0.803, 1.828], 1: [0, 1.829], 2: [-0.803, 1.828], 6: [-0.8, -1.829], 7: [0, -1.829], 8: [0.8, -1.829] },
      ...{ 3: [-1.844, 0.794], 4: [-1.843, 0], 5: [-1.842, -0.796], 9: [1.842, -0.796], 10: [1.843, 0], 11: [1.844, 0.794] }, // 左右两侧只有夹带用（LAB_GAP）
    },
    collider: [4.5, 4.5],
    levelZ: 3,
    supported: true,
  },
};
/**
 * 研究站夹带（宇宙矩阵 6 进 1 出，上下两侧各 3 个位不够；game-rules 第 40 条，plan/graph.js 的 sideItemOf、plan/layout/belts.js 的 labGaps）：
 * 两叠中心隔 6，中间那一列夹一条往北流的带，产物经长 1 的侧面分拣器（横着）放上去，带在研究站那一行最上面那格原地升起走高架。
 * 左边那叠用右侧 11 号（槽位 y +0.794，接 cy + 1 那格），右边那叠用左侧 4 号（y 0，接 cy 那格）：两台从两边接同一格会撞（推断），所以接相邻两格
 */
export const LAB_GAP = { left: 11, right: 4 };
/**
 * 同类里比基础款大的高级款（按建筑 ID 覆盖 FACTORY_GEOMETRY）。
 * 量子化工厂（实测，game-rules 第 23 条）：比化工厂宽、一样高，宽至少 7.2，取游戏数据里的占地宽 8（Buildings.json area [4,2]）。
 * 间距 8、块右边空 1 列（中心 4、块宽 8n + 1）：右边紧挨熔炉时中心隔 6（4 + 1.2 ≤ 6），左右挨制造台、化工厂、研究站、对撞机也都够；
 * 本体按 9 格占格子（碰撞体 ±4 压到两边那格的一半）。上下、槽位照化工厂。
 * 研究站、熔炉、制造台的高级款实测和基础款一样大，不用覆盖。
 */
const GEOMETRY_BY_ID = {
  2317: { pitch: 8, center: 4, trailing: 1, bodyWidth: 9, collider: [8, 4] },
};
/**
 * 高纬度版的化工厂、量子化工厂、原油精炼厂。网页默认用赤道那套，左栏「化工厂、精炼厂高纬度间距展开」打开才用这套；
 * 命令行默认这套（calculate() 的 latitude）。
 * 为什么：东西向的格子离赤道越远越窄（赤道到 28.8° 从 100% 缩到 88%，往后每段在 83%~100% 之间来回，game-rules 第 26 条），
 * 建筑大小不变：化工厂碰撞体宽按 6.8 算、隔 7 只有 3% 的余量，只在每段靠赤道的一头能放；精炼厂碰撞体宽 2.8、并排隔 3 只有 7% 余量，
 * 格宽不到 93% 就撞。高纬度版每台左右各多留 1 格，按本体加宽占格子（站、供电设施、带子也都离开这一格）：
 *   化工厂间距 8、块两头各空 1 列（中心 4、块宽 8n + 1），要格宽 ≥ 85%，85° 以内只有几条分界线南边不到 1° 的窄条不够；
 *   量子化工厂碰撞体按 8 算（实测 7.2~8 之间），间距 10、中心 5、块宽 10n + 1，要格宽 ≥ 80%，82.6° 以内都够；
 *   精炼厂间距 4、中心 2、块宽 4n + 1，左右挨制造台时要格宽 ≥ 75%，任何纬度都够。
 * 别的建筑（研究站隔 5、对撞机隔 9）余量也小，还没报过撞，没动。
 */
const GEOMETRY_HIGH_LATITUDE = {
  2309: { pitch: 8, center: 4, trailing: 1, bodyWidth: 9 },
  2317: { pitch: 10, center: 5, trailing: 1, bodyWidth: 11 },
  2308: { pitch: 4, center: 2, trailing: 1, bodyWidth: 5 },
};
const FACTORY_KIND = {
  2302: 'smelter', 2315: 'smelter', 2319: 'smelter',
  2303: 'assembler', 2304: 'assembler', 2305: 'assembler', 2318: 'assembler',
  2309: 'chemical', 2317: 'chemical',
  2308: 'refinery',
  2310: 'collider',
  2901: 'lab', 2902: 'lab',
  2101: 'store', 2102: 'store', 2106: 'store', // 箱子供货时储物仓、储液罐当工厂排进行里（几何见 STORE_GEOMETRY）
};

/**
 * latitude：'high' 时化工厂、量子化工厂、原油精炼厂用高纬度版的间距（GEOMETRY_HIGH_LATITUDE），'equator' 用赤道压缩的间距，别的工厂不变。
 * 这里默认 'equator' 是工厂本来的几何（独立检查、体积测试按碰撞体查，和间距无关）；规划默认用哪套看 calculate() 的 latitude。
 * 这三种的返回值带 latitude，说明这次按哪套间距排。
 */
export function factory(id, latitude = 'equator') {
  const kind = FACTORY_KIND[id];
  if (!kind) throw new Error(`未知工厂 ID ${id}`);
  const it = ITEMS.get(id);
  const high = latitude === 'high' ? GEOMETRY_HIGH_LATITUDE[id] : null;
  const geo = kind === 'store' ? STORE_GEOMETRY[id] : { ...FACTORY_GEOMETRY[kind], ...GEOMETRY_BY_ID[id], ...high };
  return { id, name: it.name, speed: it.speed, kind, ...geo, bodyHeight: (geo.bodyBelow ?? 1) + (geo.bodyAbove ?? 1) + 1, ...(id in GEOMETRY_HIGH_LATITUDE ? { latitude: high ? 'high' : 'equator' } : null) };
}
/** 这台工厂有没有高纬度版（化工厂、量子化工厂、原油精炼厂） */
export const hasHighLatitude = (id) => id in GEOMETRY_HIGH_LATITUDE;
/**
 * 能从头顶跨过的工厂（实测，game-rules 第 31 条）：熔炉、制造台（和储物箱）都是 3 层高，第 4~7 层的传送带能从它们头顶经过；
 * 物流站、卫星配电站更高，不能过；对撞机也更高（高多少不知道）。规划器的校验（plan/validate.js）只放行 OVERPASS_IDS，别的工厂按不能过；
 * 独立检查按每种建筑实测的最低高度放行（下面的 OVER_MIN_Z），上限都是 OVERPASS_ZMAX
 */
export const OVERPASS_Z = 4; // 带子至少在第几层才能从这些工厂头顶过（比工厂高出的层数，工厂都在地面）
export const OVERPASS_ZMAX = 7; // 只确认到第 7 层，再高的照旧当压着工厂报
export const OVERPASS_IDS = new Set([2302, 2315, 2319, 2303, 2304, 2305, 2318]);

// 传送带相邻两节水平走一格时高度最多变几层：0，不出一格斜坡（看起来是折的）。高架都在地面那一格原地竖直升到第 L 层再水平走，
// 落下时同样原地竖直落到地面，和游戏里手拉的官方垂直传送带一样（game-rules 第 6 条）。不用原地升降（noLift）时的坡见 RAMP_STEP
export const RAMP_MAX_DZ = 0;
/**
 * 半层（game-rules 第 38 条）：贴蓝图时 z 原样用（z 每 1 是一层 1.3333 m），手拉横穿别的带子时游戏自己抬半层（z 0.5）。
 * 规划器「不用原地升降」（route.js 的 noLift）的坡一格升降 RAMP_STEP 层：没解锁「超级磁场发生器」时一格最多约 0.586 层
 * （NO_TECH_MAX_DZ，游戏代码），半层在任何纬度都行。
 * 同一格里两节不同的带子上下至少隔 LEVEL_GAP 层（规划器自己的规矩，手拉跨线就是半层；同一张图里带子之间游戏不查碰撞）
 */
export const RAMP_STEP = 0.5;
export const LEVEL_GAP = 0.5;
/**
 * 解锁了「超级磁场发生器」时一格最多升降几层（陡坡，game-rules 第 6 条）。坡越缓越好看：每格半层 < 每格一层的陡坡 < 原地竖直升降
 * （不禁止，但最贵），后处理重走（plan/reroute.js）照这个顺序收代价，不用原地升降（noLift）时不出陡坡。
 * 两节相距 √(1.2566² + 1.3333²) = 1.83 m，不到游戏的 √5.3 m；没解锁时贴不上（独立检查的 noTech 照样报）
 */
export const STEEP_DZ = 1;
/** 游戏的几何（m）：赤道上一格、蓝图 z 每 1、相邻两节带子最远（√5.3，再远报「太远」）、东西向最窄的格（赤道的几分之几，85° 以内） */
export const CELL_M = 1.2566;
export const LEVEL_M = 4 / 3;
export const BELT_LINK_M = Math.sqrt(5.3);
export const NARROW_EW = 0.829;
/** 没解锁超级磁场时相邻两节连线和竖直方向夹角的余弦上限（BuildTool_BlueprintPaste，推断：来自代码）；对应一格最多升降多少层（按最窄的格） */
export const NO_TECH_SIN = 0.6;
export const NO_TECH_MAX_DZ = (NO_TECH_SIN / Math.sqrt(1 - NO_TECH_SIN ** 2)) * CELL_M * NARROW_EW / LEVEL_M;
/**
 * 带子从建筑头顶过的最低高度（层，比建筑高出的；实测，每种一高一低两组夹住，game-rules 第 38 条）。
 * 和游戏代码一致：带子拿节点往上 0.2 m、半径 0.23 m 的球查碰撞，能过的最低层 =（碰撞盒顶 + 0.03 m）÷ 1.3333。
 * 独立检查照这个放行（上限仍是 OVERPASS_ZMAX）。化工厂（量子化工厂一样）左边的塔在建筑自己坐标 x ≤ CHEM_TOWER.x 那几格
 */
export const OVER_MIN_Z = { 2302: 3, 2315: 3, 2319: 3, 2303: 3.6, 2304: 3.6, 2305: 3.6, 2318: 3.6, 2901: 3, 2902: 3, 2309: 3, 2317: 3 };
export const CHEM_TOWER = { x: -0.5, z: 5 };
/**
 * 带子从供电设施头顶过的最低高度（实测，game-rules 第 38 条）。卫星配电站的顶盘（5.49 格见方，离地 6~7 m）比底座宽：
 * 底下离中心 2 格那圈 4 能放、4.5 撞（顶盘在 4.18~5.27 层之间，推断：碰撞盒）
 */
export const POWER_OVER_Z = { 2201: 4.5, 2212: 5.5 };
export const SUBSTATION_DISK = { reach: 2, lo: 4.18, hi: 5.27 };
/** 带子从储物仓、储液罐头顶过的最低高度（层，一叠最上面那个之上）：小型仓实测 1.5 红、2 能放；大型仓、储液罐按碰撞盒推的 2.84、2.97 */
export const STORE_OVER_Z = { 2101: 2, 2102: 3, 2106: 3 };
/** 物流站口那节带子离站中心不能超过 4 m（游戏代码；实测 z 2 能接、2.5 太远） */
export const STATION_PORT_M = 4;
/** 分拣器连线和两头朝向的夹角上限（度，游戏代码）；建好时带子那头离带子节点超过 √5 m 会断开 */
export const SORTER_MAX_TILT = 24;
export const SORTER_REACH_M = Math.sqrt(5);
/**
 * 分拣器在工厂那头贴图时吸到的槽位离中心多远（格，赤道）：制造台 0.8745（游戏写的蓝图里量的），熔炉没量过，
 * 按测试 D11 在赤道能贴（要不超过约 0.797）取和小型储物仓一样的 0.795（推断）。规划器写在工厂边上（1 格），独立检查算斜度时换成这个
 */
export const SLOT_DEPTH = { 2303: 0.8745, 2304: 0.8745, 2305: 0.8745, 2318: 0.8745, 2302: 0.795, 2315: 0.795, 2319: 0.795 };
/**
 * 两座星际物流站中心之间的最小直线距离（格）：29 m ÷ 1.2566 m/格 = 23.08 格（实测吻合，game-rules 第 10 条），斜着相对时拿不准，
 * 再加 1 格余量。只对南北向准：东西向的格数先按最窄的格宽折算再比（stationSpan，game-rules 第 41 条）。
 */
export const STATION_GAP = 24.08;
/**
 * 两座物流站（game-rules 第 41 条）：游戏量两座站底座中心（离地 0.2 m）的三维直线距离，有星际站的一对要 ≥ 29 m，
 * 两座行星内物流站 ≥ 15 m（游戏代码）。东西向格子随纬度变窄，所以东西向的格数先乘最窄的格宽：规划器统一按 STATION_EW_RATIO
 * （高于 15 行的蓝图最远贴到 64.8° 那条纬度带，格宽 0.8516；接站的图都比这高），独立检查按蓝图自己的行数算能贴到的最坏纬度（stationWorstM）
 */
export const STATION_M = 29;
export const STATION_PLS_M = 15;
export const STATION_GAP_PLS = 12.94; // 两座行星内物流站（2103）：15 m ÷ 1.2566 + 1 格余量，同 STATION_GAP 的算法
/**
 * 纬度带（game-rules 第 26、41 条，PlatformSystem.segmentTable 算出来的，半径 200 的星球）：起止格行（一行 0.36°，赤道带连南半球）、东西向一圈几格。
 * 一张蓝图要整张落在同一条带里（不然游戏报「非法跨越回归线」），所以高 H 行的蓝图只贴得进行数 ≥ H 的带；
 * 带里越往北东西向格子越窄，最北一行最窄（格宽 = cos 纬度 × 1000 ÷ 格数，赤道的几分之几）
 */
export const LAT_BANDS = [
  { lo: -80, hi: 80, cells: 1000 }, // 南北纬 28.8° 以内，161 行，最窄 0.876
  { lo: 81, hi: 130, cells: 800 }, // 到 46.8°，50 行，0.856
  { lo: 131, hi: 155, cells: 600 }, // 到 55.8°，25 行，0.937
  { lo: 156, hi: 180, cells: 500 }, // 到 64.8°，25 行，0.852
  { lo: 181, hi: 195, cells: 400 }, // 到 70.2°，15 行，0.847
  { lo: 196, hi: 210, cells: 300 }, // 到 75.6°，15 行，0.829
  { lo: 211, hi: 220, cells: 200 }, // 到 79.2°，10 行，0.937
  { lo: 221, hi: 230, cells: 160 }, // 到 82.8°，10 行，0.783
];
const ROW_RAD = (2 * Math.PI) / 1000;
const bandRatio = (b) => (Math.cos(b.hi * ROW_RAD) * 1000) / b.cells;
/** 高 rows 行的蓝图能贴到的最窄东西向格宽（赤道的几分之几） */
export function narrowestEW(rows) {
  let r = 1;
  for (const b of LAT_BANDS) if (b.hi - b.lo + 1 >= rows) r = Math.min(r, bandRatio(b));
  return r;
}
export const STATION_EW_RATIO = narrowestEW(16);
/** 两座站中心偏 (dx, dy) 格（dx 东西）按最窄格宽折算后的格数，和 STATION_GAP 比（规划器、拼接用） */
export const stationSpan = (dx, dy, ew = STATION_EW_RATIO) => Math.hypot(dx * ew, dy);
/**
 * 两座站中心偏 (dx, dy) 格（dx 东西），贴在高 rows 行的蓝图能到的最坏纬度时的三维直线距离（m）和那条带的北沿纬度（°）：
 * 每条够高的带都把北边那座放在带的最北一行（东西向最窄），底座离地 0.2 m（独立检查用）
 */
export function stationWorstM(dx, dy, rows) {
  const R = 200.2;
  const dir = (lon, lat) => [Math.cos(lat) * Math.sin(lon), Math.sin(lat), -Math.cos(lat) * Math.cos(lon)];
  let best = { m: Infinity, deg: 0 };
  for (const b of LAT_BANDS) {
    if (b.hi - b.lo + 1 < Math.max(rows, Math.abs(dy) + 1)) continue;
    const p = dir(0, b.hi * ROW_RAD);
    const q = dir((Math.abs(dx) * 2 * Math.PI) / b.cells, (b.hi - Math.abs(dy)) * ROW_RAD);
    const m = R * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (m < best.m) best = { m, deg: +(b.hi * 0.36).toFixed(1) };
  }
  return best;
}
/**
 * 物流站身（7×7）外面还有 1 格碰撞圈（实测，game-rules 第 17、19 条），按 9×9 的方形算、不抠角（斜对着的能不能放和纬度有关）。
 * 这一圈只挡卫星配电站，电力感应塔、制造台、熔炉、叠层研究站、带子都能贴着站身，所以规划和检查都只让卫星配电站不进这一圈。
 * 这里是站中心到这一圈外沿的格数（站身是 3）。
 */
export const STATION_CLEAR = 4;
/**
 * 东西向（蓝图 x）再让一截：卫星配电站的格子也不进站心左右第 STATION_EW.x 列、上下 STATION_EW.y 行以内，即配电站中心要东西隔 7 格以上
 * 或南北隔 6 格以上。离赤道远了东西向格子变窄，正好隔 6 格的在 16° 以外就压上了；实测（回归线下）(6, 5) 能放，
 * 所以禁区只到南北错开 4 行（game-rules 第 39 条）
 */
export const STATION_EW = { x: 5, y: 3 };
/**
 * 判物流站和工厂碰撞时站身的半宽（格）。站身占 7×7，但制造台本体紧贴站身（中心隔 5）实测能放，
 * 而制造台碰撞体确实大于 3 格（两台隔 3 撞，按 3.2 算），按 3.5 + 1.6 > 5 会误报，所以站这边取 3.4。
 */
export const STATION_HALF = 3.4;
/**
 * 卫星配电站占 3×3，紧挨着制造台、熔炉放（中心隔 3，本体之间不留缝）实测可以（game-rules 第 17、19 条）。
 * 供电设施之间另有最小间距（实测，game-rules 第 19~21 条）：两座配电站中心隔 3~5 撞、隔 6 能放（东西向见 SUBSTATION_EW），
 * 配电站和塔、塔之间见 powerGap
 */
export const SUBSTATION_GAP = 6;
/**
 * 两座卫星配电站（game-rules 第 41 条）：顶盘 5.49 格见方、离地 6~7 m，比底座宽，两座的顶盘碰上就撞（游戏只按碰撞体判，
 * 3.5 m 的供电设施间距这么远用不上）。斜着 (4,5)、(5,4)、(5,5) 直线够 6 格也碰（实测 (4,−5) 撞），东西隔 6 在纬度带靠北那头会碰
 * （碰撞体推算），所以按最坏纬度要东西隔 SUBSTATION_EW 或南北隔 SUBSTATION_GAP（10 行以内的蓝图贴到 79.6°~82.8° 那条带时
 * 东西隔 7、南北错开 1 行以内的也碰，不管）
 */
export const SUBSTATION_EW = 7;
/** 两座供电设施中心的最小直线距离（格）：配电站和塔 2√2、塔之间 2√2（2.24 不行、2.83 能放）；两座配电站不按直线距离，见 powerApart */
export function powerGap(a, b) {
  if (a === 2212 && b === 2212) return SUBSTATION_GAP;
  return Math.SQRT2 * 2;
}
/** 两座供电设施中心偏 (dx, dy) 格（dx 东西）能不能这样放（规划器、拼接用，按最坏纬度）：两座配电站要南北隔 6 或东西隔 7，别的按直线距离 powerGap */
export function powerApart(a, b, dx, dy) {
  if (a === 2212 && b === 2212) return Math.abs(dy) >= SUBSTATION_GAP || Math.abs(dx) >= SUBSTATION_EW;
  return dx * dx + dy * dy >= powerGap(a, b) ** 2 - 1e-9;
}
/** 供电设施中心在 (x, y) 时占的格子：电力感应塔 1 格，卫星配电站 3×3 */
export function powerCells(itemId, x, y) {
  if (itemId !== 2212) return [[x, y]];
  const out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push([x + dx, y + dy]);
  return out;
}
/**
 * 供电设施能不能紧贴工厂本体放（不隔那 1 格缝；实测，game-rules 第 19~21 条）：电力感应塔所有工厂都可以贴；
 * 卫星配电站紧挨制造台、熔炉（中心隔 3）可以，对化工厂、研究站、对撞机见 substationPad。
 */
export function powerHugs(powerItemId, g) {
  if (powerItemId === 2212) return g.kind === 'smelter' || g.kind === 'assembler' || (g.kind === 'lab' && (g.levels ?? 1) <= 1);
  return true;
}
/**
 * 卫星配电站离各种工厂要留多远（实测：体积测试第六张、验证合集 S 组、体积测试第九张，game-rules 第 25、28、32 条）。
 * 返回两样：pad 规划器在工厂本体外多算占用的格数 { left, right, below, above }（上下的那几行只占本体那几列），
 * margin 独立检查里配电站 3×3 和工厂碰撞体之间至少要隔的距离 { left, right, below, above }（按工厂自己的朝向，紧贴能放的为 0）。
 * 熔炉、制造台、单层研究站可以贴（pad 都是 0，margin 为 null）。
 */
export function substationPad(g) {
  // 化工厂左边、下沿紧贴撞，别的方向能贴；叠层研究站右边、上面紧贴和斜角都撞（单层能贴），四周都留；
  // 对撞机右边、上面隔 1 格能放，左边、下面隔 1 格还撞（按隔 2 留，隔 2 没量，推断）
  if (g.kind === 'chemical') return { pad: { left: 1, right: 0, below: 1, above: 0 }, margin: { left: 0.5, right: 0, below: 0.5, above: 0 } };
  if (g.kind === 'lab' && (g.levels ?? 1) > 1) return { pad: { left: 1, right: 1, below: 1, above: 1 }, margin: { left: 1, right: 1, below: 1, above: 1 } };
  if (g.kind === 'collider') return { pad: { left: 2, right: 1, below: 2, above: 1 }, margin: { left: 1.5, right: 0.5, below: 1.5, above: 0.5 } };
  // 原油精炼厂左右、北边隔 1 格还撞、隔 2 格能放，南边（有口那头）紧贴撞、隔 1 行能放，四个角跟着留
  if (g.kind === 'refinery') return { pad: { left: 2, right: 2, below: 1, above: 2 }, margin: { left: 1.5, right: 1.5, below: 1, above: 1.5 } };
  if (g.kind === 'smelter' || g.kind === 'assembler' || g.kind === 'lab') return { pad: { left: 0, right: 0, below: 0, above: 0 }, margin: null };
  return { pad: { left: 1, right: 1, below: 0, above: 0 }, margin: null };
}
/**
 * 分拣器在工厂一端的落点（相对工厂中心）。off = 分拣器所在列（接的那格带子的 x）− 工厂中心。
 * 有 slotPos 的工厂（研究站、对撞机）用槽位的精确位置，分拣器整根对齐到这个 x；其他工厂落在本列，y 为 ±edge。
 */
export function slotPoint(g, side, off) {
  const slot = g.slots?.[side]?.[off];
  const exact = slot == null ? null : g.slotPos?.[slot];
  if (exact) return { slot, dx: exact[0], dy: exact[1] };
  return { slot, dx: off, dy: side === 'bottom' ? -g.edgeBelow + (g.edgeShiftBelow ?? 0) : g.edgeAbove };
}
/**
 * 副产物（比如石墨烯高效配方多出来的氢）在生产图里单独走一条带、单独送出，和产线自己要用的同种物品分开。
 * 生产图里它的物品编号是「真实编号 + BYPRODUCT」，出蓝图、物流站存储时用 realItem 换回真实编号。
 */
export const BYPRODUCT = 100000;
/**
 * 箱子供货时同一种原料按用料的工厂组分成几组仓（plan/storage.js 的 storeUnits），第 k 组（k ≥ 1）在生产图里的编号是
 * 「真实编号 + STORE_COPY × k」，各走各的带；baseItem 换回原来的编号（页面画图、喷不喷按它）
 */
export const STORE_COPY = 1000000;
export const realItem = (id) => id % BYPRODUCT;
export const baseItem = (id) => (id >= STORE_COPY ? id % STORE_COPY : id);

/**
 * 每种物品一格能放几个（储物仓按这个算装得下多少），来自原版游戏的物品表导出（github.com/dsp2b/dsp2b 的
 * data/itemProtoSet.json，GPL-3.0；和 ProjectGenesis 的 items_vanilla.json 对过，只差那个 MOD 改过的 3 种）。
 * 黑雾引力透镜（1211，0.10.35 新出的）那份里没有，按引力透镜的 100 算（推断）。
 */
export const STACK_SIZE = {
  1000: 20, 1001: 100, 1002: 100, 1003: 100, 1004: 100, 1005: 100, 1006: 100, 1007: 20, 1011: 50, 1012: 50, 1013: 50, 1014: 50,
  1015: 50, 1016: 50, 1030: 100, 1031: 500, 1101: 100, 1102: 200, 1103: 100, 1104: 100, 1105: 100, 1106: 100, 1107: 100, 1108: 100,
  1109: 100, 1110: 100, 1111: 100, 1112: 100, 1113: 100, 1114: 20, 1115: 100, 1116: 20, 1117: 100, 1118: 100, 1119: 100, 1120: 20,
  1121: 20, 1122: 20, 1123: 100, 1124: 100, 1125: 100, 1126: 100, 1127: 100, 1128: 100, 1129: 100, 1130: 100, 1131: 1000, 1141: 200,
  1142: 200, 1143: 200, 1201: 200, 1202: 200, 1203: 100, 1204: 100, 1205: 100, 1206: 100, 1208: 100, 1209: 100, 1210: 100, 1301: 200,
  1302: 200, 1303: 200, 1304: 200, 1305: 200, 1401: 200, 1402: 200, 1403: 20, 1404: 200, 1405: 200, 1406: 100, 1407: 200, 1501: 200,
  1502: 100, 1503: 20, 1601: 100, 1602: 100, 1603: 100, 1604: 100, 1605: 100, 1606: 100, 1607: 100, 1608: 100, 1609: 100, 1610: 100,
  1611: 100, 1612: 100, 1613: 100, 1801: 30, 1802: 30, 1803: 30, 1804: 50, 2001: 300, 2002: 300, 2003: 300, 2011: 200, 2012: 200,
  2013: 200, 2014: 200, 2020: 50, 2030: 100, 2040: 50, 2101: 50, 2102: 50, 2103: 10, 2104: 10, 2105: 10, 2106: 50, 2107: 50,
  2201: 100, 2202: 100, 2203: 50, 2204: 50, 2205: 50, 2206: 50, 2207: 50, 2208: 20, 2209: 20, 2210: 20, 2211: 50, 2212: 30,
  2213: 50, 2301: 50, 2302: 50, 2303: 50, 2304: 50, 2305: 50, 2306: 30, 2307: 20, 2308: 30, 2309: 30, 2310: 20, 2311: 30,
  2312: 10, 2313: 50, 2314: 30, 2315: 50, 2316: 30, 2317: 30, 2318: 50, 2319: 50, 2901: 50, 2902: 50, 3001: 50, 3002: 50,
  3003: 50, 3004: 50, 3005: 50, 3006: 50, 3007: 20, 3008: 20, 3009: 20, 3010: 20, 5001: 200, 5002: 50, 5003: 200, 5101: 100,
  5102: 100, 5103: 100, 5111: 50, 5112: 50, 5201: 200, 5202: 100, 5203: 100, 5204: 50, 5205: 50, 5206: 100, 6001: 200, 6002: 200,
  6003: 200, 6004: 200, 6005: 200, 6006: 200,
  1211: 100,
};
export const stackSize = (id) => STACK_SIZE[realItem(id)] ?? 100;
// 储物仓、储液罐、物流配送器（实测，game-rules 第 30 条；参考图 test/fixtures/ref-box.bp.txt）。
// 分拣器口（建筑自己坐标，朝北，编号照制造台）：大型仓长边各三个、短边各一个；小型仓每边三个，南边 6、8 号和东、西两边的角口
// （5、9、11 号）是照北边对称推断的（独立检查用到时提醒）。储液罐不用分拣器，带子直接接四边的口（北 0、东 1、南 2、西 3）。
// 碰撞体（STORE_BODY）：小型仓 2.4×2.4（实测大于 2、不超过 2.8）；大型仓按同样的比例 4.4×2.4（隔 5、隔 3 没测）；
// 储液罐两个隔 3 还撞，按 3.5×3.5（隔 4 没测）。分拣器可以伸进仓的碰撞体（口就在里面）。
// 叠一层的高度（lift）、配送器比一叠最上面那个仓高多少（DISTRIBUTOR_LIFT）是实测
export const BOX_SLOT = {
  2101: { 0: [-0.797, 0.795], 1: [0, 0.795], 2: [0.797, 0.795], 3: [0.797, 0.795], 4: [0.824, 0], 5: [0.797, -0.795], 6: [0.797, -0.795], 7: [0, -0.795], 8: [-0.797, -0.795], 9: [-0.797, -0.795], 10: [-0.823, 0], 11: [-0.797, 0.795] },
  2102: { 0: [-1, 0.874], 1: [0, 0.874], 2: [1, 0.874], 4: [1.894, 0], 6: [1, -0.874], 7: [0, -0.874], 8: [-1, -0.874], 10: [-1.894, 0] },
};
export const TANK_PORT = { 0: [0, 1.11], 1: [1.15, 0], 2: [0, -1.11], 3: [-1.15, 0] };
/** 储液罐北、南口出来的两节带子（照参考图）：口上那节在中心外 1.113 格、高 0.0037，下一节在外 1.987 格、高 0.0117，再下一节才落到外 3 格的整格上 */
export const TANK_STUB = { port: 1.113, mid: 1.987, zPort: 0.0037, zMid: 0.0117 };
export const STORE_BODY = { 2101: { w: 2.4, h: 2.4, lift: 2, cap: 30 }, 2102: { w: 4.4, h: 2.4, lift: 3, cap: 60 }, 2106: { w: 3.5, h: 3.5, lift: 3 } };
export const DISTRIBUTOR_LIFT = { 2101: 1.875, 2102: 2.981 };
/**
 * 箱子供货时储物仓当工厂排进生产行里（game-rules 第 30 条）：小型仓碰撞体 2.4×2.4 和电弧熔炉一样，宽 3、隔 3（实测隔 3 能放），
 * 上下各三个口（北 0 1 2、南 8 7 6，左中右）；大型仓 4.4×2.4，宽 5、隔 5（推断：照小型仓隔 3 留的 0.6 格），长边各三个口。
 * 一叠算一台，levelZ 是叠一层抬多高。
 * 储液罐（液体原料）：碰撞体按 3.5×3.5（推断：两个隔 3 还撞），上下各占 2 行，带子落在离罐中心 3 格那条（罐口出来的两节见 TANK_STUB），
 * 宽 5、隔 5（推断，隔 4 没测）；上下各一个口（北 0、南 2），不用分拣器
 */
const STORE_GEOMETRY = {
  2101: { bodyWidth: 3, bodyBelow: 1, bodyAbove: 1, edgeBelow: 1, edgeAbove: 1, edgeShiftBelow: 0, trailing: 0, pitch: 3, center: 1, collider: [2.4, 2.4], supported: true, slots: SLOTS_3x3, slotPos: BOX_SLOT[2101], levelZ: STORE_BODY[2101].lift },
  2102: { bodyWidth: 5, bodyBelow: 1, bodyAbove: 1, edgeBelow: 1, edgeAbove: 1, edgeShiftBelow: 0, trailing: 0, pitch: 5, center: 2, collider: [4.4, 2.4], supported: true, slots: SLOTS_3x3, slotPos: BOX_SLOT[2102], levelZ: STORE_BODY[2102].lift },
  2106: { bodyWidth: 5, bodyBelow: 2, bodyAbove: 2, edgeBelow: 2, edgeAbove: 2, edgeShiftBelow: 0, trailing: 0, pitch: 5, center: 2, collider: [3.5, 3.5], supported: true, slots: { bottom: { 0: 2 }, top: { 0: 0 } }, slotPos: { 0: [0, TANK_STUB.port], 2: [0, -TANK_STUB.port] }, levelZ: STORE_BODY[2106].lift },
};
/** 液体（同一份物品表的 IsFluid）：箱子供货时用储液罐直接接带，不用储物仓 */
export const FLUIDS = new Set([1000, 1007, 1114, 1116, 1120, 1121]); // 水、原油、精炼油、硫酸、氢、重氢
/** 精炼厂只排等离子精炼：X 射线裂解、重整精炼的原料里有自己的产物，排不了 */
const REFINERY_RECIPES = new Set([16]);
const kindOk = (f, recipeId) => !!FACTORY_GEOMETRY[FACTORY_KIND[f]]?.supported && (FACTORY_KIND[f] !== 'refinery' || REFINERY_RECIPES.has(recipeId));
const isSupported = (r) => r.factories.some((f) => kindOk(f, r.id));
/** 这道配方在这种工厂里能不能排（储物仓这类按几何表；精炼厂只认等离子精炼） */
export const plannable = (recipeId, factoryId) => (FACTORY_KIND[factoryId] === 'store' ? true : kindOk(factoryId, recipeId));
/**
 * 计算器默认用哪个配方做这种物品：编号最小的单产物配方（不管工厂排不排得了）；
 * 没有单产物配方时，才用「这种物品是第一个产物、工厂排得了、原料里没有它自己」的带副产物配方（比如反物质只能用质能储存，同时出氢）。
 * 都没有就是原料（从边缘或物流站进）。单产物配方原料里有它自己的不用（只有精炼油的重整精炼：从头做不出来、精炼厂也排不了），
 * 改用可选配方的第一个（精炼油用等离子精炼，副产氢单独送出）
 */
export function defaultRecipe(itemId) {
  const all = recipesProducing(itemId).filter((r) => r.type !== -1 && r.outputs[0].id === itemId).sort((a, b) => a.id - b.id);
  const self = (r) => r.inputs.some((x) => x.id === itemId);
  const one = all.find((r) => r.outputs.length === 1);
  if (one && self(one)) return recipeChoices(itemId)[0] ?? null;
  return one ?? all.find((r) => isSupported(r) && !self(r)) ?? null;
}
/**
 * 一种物品可选的配方：类型不是「无中生有」、这种物品是第一个产物、工厂能排、原料里没有它自己。
 * 化工厂、精炼厂带副产物的配方里这种物品排在后面的也算（比如氢有两种做法，精炼厂的等离子精炼、可燃冰的石墨烯（高效）；
 * 选了它，另一个产物当副产物单独送出）。第一个是默认配方（编号最小的单产物配方），其余是「新配方」（高效、原始等）。
 */
const coProduct = (r, itemId) => r.outputs[0].id === itemId || r.factories.some((f) => FACTORY_KIND[f] === 'chemical' || FACTORY_KIND[f] === 'refinery');
export function recipeChoices(itemId) {
  const all = recipesProducing(itemId)
    .filter((r) => r.type !== -1 && coProduct(r, itemId) && !r.inputs.some((x) => x.id === itemId) && isSupported(r))
    .sort((a, b) => a.id - b.id);
  const def = all.find((r) => r.outputs.length === 1) ?? all[0] ?? null; // 没有单产物配方时（反物质），带副产物的就是默认
  return def ? [def, ...all.filter((r) => r !== def)] : [];
}
export const BELT_IDS = { 1: 2001, 2: 2002, 3: 2003 };
/** 单层（不堆叠）传送带运力，个/秒 */
export const BELT_SPEED = { 1: 6, 2: 12, 3: 30 };

/**
 * 建筑碰撞框（朝北、yaw 0 时）：宽、高、中心相对建筑位置的偏移。工厂取 factory() 的 collider，物流站 7×7，储物仓、储液罐取 STORE_BODY，
 * 卫星配电站 3×3；火力发电厂是验证合集 R 组实测的 6.5 × 3.5（朝东量的，game-rules 第 27、28 条；框往上挪半格是推断）。
 * 暂时没有调用方，留给以后统一碰撞框用
 */
export const BUILDING_BODY = new Map([
  ...[2302, 2315, 2319, 2303, 2304, 2305, 2318, 2309, 2317, 2901, 2902, 2310].map((id) => {
    const f = factory(id);
    return [id, { w: f.collider[0], h: f.collider[1], sx: f.colliderShift?.[0] ?? 0, sy: f.colliderShift?.[1] ?? 0 }];
  }),
  ...[2103, 2104].map((id) => [id, { w: 2 * STATION_HALF, h: 2 * STATION_HALF, sx: 0, sy: 0 }]),
  ...Object.entries(STORE_BODY).map(([id, b]) => [Number(id), { w: b.w, h: b.h, sx: 0, sy: 0 }]),
  [2212, { w: 3, h: 3, sx: 0, sy: 0 }],
  [2204, { w: 3.5, h: 6.5, sx: -0.5, sy: 0 }],
]);
/** 建筑 id 摆在 (x, y)、朝向 yaw 时碰撞框盖住中心的格子，逐个交给 put(gx, gy)；不认识的建筑不算 */
export function bodyCells(id, x, y, yaw, put) {
  const b = BUILDING_BODY.get(id);
  if (!b) return;
  const t = ((Math.round(yaw ?? 0) % 360) + 360) % 360;
  // yaw 0 北、90 东（顺时针）：建筑自己坐标里的 (dx, dy) 转 90° 后是 (dy, −dx)，宽高对调
  const [sx, sy] = t === 90 ? [b.sy, -b.sx] : t === 180 ? [-b.sx, -b.sy] : t === 270 ? [-b.sy, b.sx] : [b.sx, b.sy];
  const [w, h] = t % 180 ? [b.h, b.w] : [b.w, b.h];
  const cx = x + sx;
  const cy = y + sy;
  const E = 1e-3; // 蓝图里的坐标是单精度浮点
  for (let gx = Math.ceil(cx - w / 2 - E); gx <= Math.floor(cx + w / 2 + E); gx++) for (let gy = Math.ceil(cy - h / 2 - E); gy <= Math.floor(cy + h / 2 + E); gy++) put(gx, gy);
}
