// 轨道：每个通道里地面段分到第几条轨道、按流量重排，再定各通道和工厂行的纵向位置
import { SORTER_SPEED } from '../sorters.js';
import { TRACK_PERMS } from './shared.js';

/** 热点里反复用的临时数组：长度不够时换一块更长的，各次调用共用（同一线程里 route() 不会重入，用完即弃） */
const SCRATCH = [];
const scratch = (slot, Type, n) => {
  let a = SCRATCH[slot];
  if (!a || a.length < n) a = SCRATCH[slot] = new Type(Math.max(n, 64));
  return a;
};

/** route() 的一步：读写共享的布局上下文 c */
export function placeTracks(c) {
  const { P, R, addPenalty, extraBottom, extraTop, opt, pos, rowAbove, rowBelow, rows, segments } = c;
  // ---------- C. 轨道分配（左边缘算法；实测同轨首尾相接的两段不会被游戏自动连上，所以可以紧挨） ----------
  // 每个通道：c 通道号、tracks 各条轨道目前的末端、n 轨道数、h 占几行、base 第一条轨道的 y（属性先后和逐个加上时一样）
  const channels = [];
  for (let c = 0; c <= R; c++) channels.push({ c, tracks: [], n: 0, h: 0, base: 0 });
  // 每个通道的地面段（保持 segments 里的先后），下面 C、C2 共用，不必每个通道都把全部段筛一遍
  const segsOf = [];
  for (let c = 0; c <= R; c++) segsOf.push([]);
  for (let i = 0; i < segments.length; i++) segsOf[segments[i].ch]?.push(segments[i]);
  for (let c = 0; c <= R; c++) {
    const ch = channels[c];
    const tracks = ch.tracks;
    // 按 (a, b) 从小到大排（插入排序，稳定，和 sort 的结果一样；一个通道里段不多）
    const segs = segsOf[c].slice();
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      let j = i - 1;
      while (j >= 0 && (segs[j].a > s.a || (segs[j].a === s.a && segs[j].b > s.b))) {
        segs[j + 1] = segs[j];
        j--;
      }
      segs[j + 1] = s;
    }
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      let t = -1;
      for (let i = 0; i < tracks.length; i++) {
        if (s.a >= tracks[i] + 1) {
          t = i;
          break;
        }
      }
      if (t < 0) {
        t = tracks.length;
        tracks.push(-Infinity);
      }
      tracks[t] = s.b;
      s.track = t;
    }
    ch.n = tracks.length;
    // 第 4 条轨（opt.fourthTrack）：下方那行的分拣器够得着第 0~2 条、上方那行够得着第 1~3 条，每根都够得着的排法在下面 C2 里找，
    // 找不到才在那里罚；别的情况照旧按超出的条数罚
    const four = opt.fourthTrack && ch.n === opt.maxTracks + 1;
    if (ch.n > opt.maxTracks && !four) addPenalty('tracks', P.tracks * (ch.n - opt.maxTracks), `通道${ch.c} 需要 ${ch.n} 条地面轨道，超过分拣器够得着的 ${opt.maxTracks} 条`, rows.flatMap((row, r) => (r === ch.c || r === ch.c - 1 ? row : [])));
    // 行与行之间至少留 1 格，防止制造台碰撞体（约 3.2 格）重叠。
    // （2026/10/06 曾让两行化工厂之间至少留 2 格，第四张体积测试 I1 I2 实测隔 1 行能放，撤回了）
    ch.h = ch.c > 0 && ch.c < R ? Math.max(ch.n, 1) : ch.n;
  }

  // ---------- C2. 轨道重排：常用的轨道挪到离使用它的工厂更近的一侧，分拣器就短 ----------
  // 4 条轨道（fourthTrack）时还要挑一种每根分拣器都够得着的排法：先比够不着的根数、再比代价；一根都躲不开就按超轨罚
  const speed = SORTER_SPEED[opt.sorter];
  for (let c = 0; c <= R; c++) {
    const ch = channels[c];
    const n = ch.n;
    const four = opt.fourthTrack && n === opt.maxTracks + 1;
    if (n < 2 || (n > 3 && !four)) continue;
    const segs = segsOf[c];
    // 每个使用者（各段的各个取放口，按段、口的先后）原来在第几条轨道，挪到第 t 条轨道时的代价 at[n·u + t]：
    // 只取决于 t，先算好，各种排列直接查（加的先后和原来一样）；far[n·u + t] 是够不着（只在 4 条轨道时数）
    let nu = 0;
    for (let i = 0; i < segs.length; i++) nu += segs[i].taps.length;
    const track = scratch(0, Int32Array, nu);
    const at = scratch(1, Float64Array, n * nu);
    const far = four ? scratch(2, Uint8Array, n * nu) : null;
    let u = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      for (let j = 0; j < s.taps.length; j++) {
        const tp = s.taps[j];
        const p = pos.get(tp.bid);
        const below = p.row !== ch.c; // 从下面一行的工厂伸上来（否则是上面一行伸下来）
        const extra = below ? extraTop(p) : extraBottom(p);
        track[u] = s.track;
        for (let t = 0; t < n; t++) {
          const len = (below ? t + 1 : n - t) + extra;
          if (len > 3) {
            at[n * u + t] = p.n * 100; // 够不着
            if (far) far[n * u + t] = 1;
            continue;
          }
          if (far) far[n * u + t] = 0;
          const k = Math.ceil((tp.rate * opt.headroom) / speed[len] - 1e-9);
          at[n * u + t] = p.n * (len - 1 + Math.max(0, k - 1) * 3);
        }
        u++;
      }
    }
    let pick = null;
    let pickCost = 0;
    let pickFar = 0;
    const perms = TRACK_PERMS[n];
    for (let q = 0; q < perms.length; q++) {
      const perm = perms[q];
      let cost = 0;
      let nf = 0;
      for (let i = 0; i < nu; i++) {
        const j = n * i + perm[track[i]];
        cost += at[j];
        if (far) nf += far[j];
      }
      if (!pick || (far ? nf < pickFar || (nf === pickFar && cost < pickCost) : cost < pickCost)) {
        pick = perm;
        pickCost = cost;
        pickFar = nf;
      }
    }
    for (let i = 0; i < segs.length; i++) segs[i].track = pick[segs[i].track];
    if (four && pickFar) addPenalty('tracks', P.tracks * (n - opt.maxTracks), `通道${ch.c} 需要 ${n} 条地面轨道，第 ${n} 条有 ${pickFar} 根分拣器够不着`, rows.flatMap((row, r) => (r === ch.c || r === ch.c - 1 ? row : [])));
  }

  // ---------- D. 纵向位置 ----------
  let y = 0;
  const rowCy = [];
  for (let c = 0; c <= R; c++) {
    channels[c].base = y;
    y += channels[c].h;
    if (c < R) {
      rowCy.push(y + rowBelow[c]);
      y += rowBelow[c] + rowAbove[c] + 1;
    }
  }
  let height = y;
  for (let i = 0; i < segments.length; i++) segments[i].y = channels[segments[i].ch].base + segments[i].track;

  Object.assign(c, { channels, height, rowCy });
}
