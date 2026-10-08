// 用电：这条线满负荷（每台工厂都在干活）时要多少电（用户 2026/10/06 要的）。
//   工厂：游戏数据（Vanilla.json 的 WorkEnergyPerTick）。研究站按实际台数（叠起来的每层都算）。
//   喷了增产剂的配方，工厂耗电多 30% / 70% / 150%（Mk.I / Mk.II / Mk.III，加速和增产一样）。
//   分拣器、喷涂机、自动集装机、物流站游戏数据里没有，按 BWIKI（2026/10/06 查）：
//     分拣器工作 18 kW、高速 36 kW、极速 72 kW、集装 144 kW；喷涂机 90 kW；自动集装机 144 kW；
//     星际物流运输站待机 60 kW，充电功率默认最多 30 MW（可调 30~300 MW，电存得越满充得越慢）。
// 物流站充电单列：它只在站里电不满时才吃满，算进总数会把生产用电淹掉。供电设施本身不耗电。
import { ITEMS } from '../gamedata.js';

export const SORTER_W = { 2011: 18e3, 2012: 36e3, 2013: 72e3, 2014: 144e3 };
export const COATER_W = 90e3;
export const PILER_W = 144e3;
export const STATION_IDLE_W = 60e3;
export const STATION_CHARGE_W = 30e6;
/** 喷了 Mk.I~Mk.III 增产剂时工厂多耗的电 */
export const SPRAY_POWER = [0, 0.3, 0.7, 1.5];

/**
 * calc：calculate() 的结果；layout：规划出来的布局（数分拣器、喷涂机、集装机、物流站）；sorter：分拣器物品编号。
 * 返回瓦：{ total 生产用电（工厂 + 分拣器 + 喷涂机 / 集装机 + 物流站待机）, factories, sorters, addons, stationIdle,
 *          stations 站数, stationCharge 物流站充电最多多少, byFactory: [{ name, count, watts }] }
 */
export function powerDemand(calc, layout, { sorter = 2013 } = {}) {
  const lv = calc.spray?.level ?? 0;
  const by = new Map();
  let factories = 0;
  for (const u of calc.units) {
    const n = u.labs ?? u.count; // 研究站：count 是叠数，labs 是实际台数
    const w = (ITEMS.get(u.factoryId)?.power ?? 0) * n * (u.spray ? 1 + SPRAY_POWER[lv] : 1);
    factories += w;
    const e = by.get(u.factory) ?? { name: u.factory, count: 0, watts: 0 };
    e.count += n;
    e.watts += w;
    by.set(u.factory, e);
  }
  const sorters = (layout.sorters ?? 0) * (SORTER_W[sorter] ?? SORTER_W[2013]);
  const addons = (layout.coaters?.length ?? 0) * COATER_W + (layout.pilers?.length ?? 0) * PILER_W;
  const stations = layout.stations?.length ?? 0;
  const stationIdle = stations * STATION_IDLE_W;
  return { total: factories + sorters + addons + stationIdle, factories, sorters, addons, stationIdle, stations, stationCharge: stations * STATION_CHARGE_W, byFactory: [...by.values()].sort((a, b) => b.watts - a.watts) };
}

/** 瓦 → 「12.3 MW」「450 kW」 */
export function fmtWatts(w) {
  if (w >= 1e9) return `${(w / 1e9).toFixed(2)} GW`;
  if (w >= 1e6) return `${(w / 1e6).toFixed(w >= 1e8 ? 0 : 1)} MW`;
  return `${Math.round(w / 1e3)} kW`;
}

/** 一句话说清用电（网页说明、命令行都用） */
export function powerText(e) {
  // 只写总数和物流站充电（玩家配电用得上的）；分项（工厂、分拣器按一直在动算的上限、喷涂机、站待机）在 e 里，要看自己取
  const charge = e.stations ? `，物流站充电另算（${e.stations} 座最多 ${fmtWatts(e.stationCharge)}，电存满后就很少）` : '';
  return `满负荷用电约 ${fmtWatts(e.total)}${charge}`;
}

/** 几块加起来（拼接、分模块时） */
export function sumPower(list) {
  const keys = ['total', 'factories', 'sorters', 'addons', 'stationIdle', 'stations', 'stationCharge'];
  return Object.fromEntries(keys.map((k) => [k, list.reduce((n, e) => n + (e[k] ?? 0), 0)]));
}
