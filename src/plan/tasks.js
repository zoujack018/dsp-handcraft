// 线程池里的一份活（网页的后台线程和命令行的 worker_threads 共用）：输入输出都能结构化克隆。
//   { kind: 'search', calc, options, rounds }  跑搜索里指定的几轮退火 → searchRounds 的结果
//   { kind: 'finish', cand, ctx }              一个候选的后处理 → finishOne 的结果
//   { kind: 'plan', calc, options }            整条产线单线程规划（基准、压力测试并行跑多条产线用）→ 去掉 graph 的 planLine 结果
import { buildGraph } from './graph.js';
import { searchRounds, exactKey } from './place.js';
import { finishOne, planLine } from './index.js';

// 同一条产线的几份搜索活（同一段里分到这个线程的几轮、没达标接着搜的下一段）共用一张生产图：
// 图只读，同一张图让 place.js 记下的初始解评估能接着用（那份记录按图认）
let graphMemo = null;
function graphOf(calc) {
  const key = exactKey(calc);
  if (key === null) return buildGraph(calc);
  if (graphMemo?.key !== key) graphMemo = { key, graph: buildGraph(calc) };
  return graphMemo.graph;
}

export function runTask(task) {
  if (task.kind === 'search') return searchRounds(graphOf(task.calc), task.options, task.rounds);
  if (task.kind === 'finish') return finishOne(task.cand, task.ctx);
  if (task.kind === 'plan') {
    const p = planLine(task.calc, task.options);
    const out = { ...p };
    delete out.graph;
    return out;
  }
  throw new Error(`未知任务 ${task.kind}`);
}
