#!/usr/bin/env node
// 打包网页：后台线程和页面逻辑都内联进一个 HTML 文件（仓库根目录的 index.html），双击即可离线打开。
// 网站（GitHub Pages 放本仓库）分中文、英文两个入口：index.html 和 en/index.html，头上的标签、根目录的 sitemap.xml、robots.txt 见 web/site.js。
// --embed <路径>：另出一份嵌进别的网站用的（开头引入同目录的 bridge.js，由它给图标；见 web/src/handoff.js）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { sitePage, sitemap, robots } from './site.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = async (entry) => {
  const r = await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    write: false,
    legalComments: 'none',
    logLevel: 'error',
  });
  return r.outputFiles[0].text;
};

const workerSrc = await bundle('web/src/worker.js');
const appSrc = await bundle('web/src/app.js');
// 防止脚本里出现 </script> 提前结束标签
const safe = (s) => s.replace(/<\/(script)/gi, '<\\/$1');
const tpl = fs.readFileSync(path.join(root, 'web/index.template.html'), 'utf8');
const page = tpl
  .replace('/*__WORKER_SRC__*/""', () => safe(JSON.stringify(workerSrc)))
  .replace('/*__APP_SRC__*/', () => safe(appSrc));
for (const [lang, file] of [['zh', 'index.html'], ['en', 'en/index.html']]) {
  const html = sitePage(page, lang);
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), html);
  console.log(`已生成 ${file}（${(html.length / 1024).toFixed(0)} KB）`);
}
fs.writeFileSync(path.join(root, 'sitemap.xml'), sitemap());
fs.writeFileSync(path.join(root, 'robots.txt'), robots());
const args = process.argv.slice(2);
if (args.includes('--embed')) {
  const dest = path.resolve(args[args.indexOf('--embed') + 1]);
  const embed = page.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<script src="bridge.js"></script>')
    .replace('<link rel="icon" href="favicon.ico">', '<link rel="icon" href="../../favicon.ico">'); // 网站图标用那个网站根目录的
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, embed);
  console.log(`已生成嵌入版 ${dest}（${(embed.length / 1024).toFixed(0)} KB）`);
}
