// 公开网站（发布副本放在 GitHub Pages 上）：蓝图生成器中文在根目录、英文在 en/，量产计算器中文在 calc/、英文在 en/calc/。
// 打包时（tools/build-web.js、发布副本的 web/build.js）给页面头上加搜索引擎和分享卡片看的标签（canonical、互相指的 hreflang、description、Open Graph），
// 英文那份写死英文的 lang、标题、默认语言。计算器只有发布副本打包（calcPage）。嵌进 DSQ 的那份不经过这里。
export const SITE = 'https://dspbp.com/';
const IMG = { w: 2880, h: 1800 }; // 发布副本 img/ 里的截图

const GEN = {
  zh: {
    path: '',
    hreflang: 'zh-CN',
    locale: 'zh_CN',
    name: '戴森球计划蓝图生成器',
    description: '戴森球计划产线蓝图生成器：选好目标产物和每分钟产量，自动排出手搓风格的产线蓝图（每种物品走自己的带，工厂分行、行间夹传送带通道），复制后贴进游戏。在浏览器里运行，不用安装。',
    image: 'img/screenshot-zh.webp',
    imageAlt: '蓝图生成器：引力矩阵 60/分',
  },
  en: {
    path: 'en/',
    hreflang: 'en',
    locale: 'en_US',
    name: 'DSP Blueprint Generator',
    title: 'DSP Blueprint Generator · Dyson Sphere Program',
    description: 'Pick a product and a rate per minute and get a Dyson Sphere Program production-line blueprint, laid out the way players build by hand. Free, in your browser.',
    image: 'img/screenshot-en.webp',
    imageAlt: 'The generator with a Gravity Matrix 60/min line',
  },
};
const CALC = {
  zh: {
    path: 'calc/',
    hreflang: 'zh-CN',
    locale: 'zh_CN',
    name: '戴森球计划量产计算器',
    description: '戴森球计划量产计算器：选目标物品和每分钟产量，算出每种设备要几台、要多少原料；点「生成蓝图」接着排成手搓风格的产线蓝图，也能出无带流蓝图，复制后贴进游戏。在浏览器里运行，不用安装。',
    image: 'img/calc-zh.webp',
    imageAlt: '量产计算器：绿矩阵（引力矩阵）60/分的生产清单',
  },
  en: {
    path: 'en/calc/',
    hreflang: 'en',
    locale: 'en_US',
    name: 'DSP Production Calculator',
    title: 'DSP Production Calculator · Dyson Sphere Program',
    description: 'Dyson Sphere Program production calculator: pick target items and a rate per minute to see how many of each building and how much raw material you need, then turn the line into a blueprint you can paste into the game. Free, in your browser.',
    image: 'img/calc-en.webp',
    imageAlt: 'The calculator with a Gravity Matrix 60/min production list',
  },
};
const OTHER = { zh: 'en', en: 'zh' };

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const must = (s, a, b) => {
  if (!s.includes(a)) throw new Error(`没找到要换的「${a}」`);
  return s.replace(a, () => b);
};
const url = (pages, lang) => SITE + pages[lang].path;
const alternates = (pages, tag) =>
  [
    ...Object.keys(pages).map((l) => `<${tag} rel="alternate" hreflang="${pages[l].hreflang}" href="${url(pages, l)}"/>`),
    `<${tag} rel="alternate" hreflang="x-default" href="${url(pages, 'en')}"/>`, // 既不是中文也不是英文的用户：给英文
  ];
/** 头上加的标签（og:site_name 是整个网站的名字，用生成器的） */
const headTags = (pages, lang) => {
  const p = pages[lang];
  const o = pages[OTHER[lang]];
  return [
    `<meta name="description" content="${attr(p.description)}">`,
    `<link rel="canonical" href="${url(pages, lang)}">`,
    ...alternates(pages, 'link').map((x) => x.replace('/>', '>')),
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${attr(GEN[lang].name)}">`,
    `<meta property="og:title" content="${attr(p.title || p.name)}">`,
    `<meta property="og:description" content="${attr(p.description)}">`,
    `<meta property="og:url" content="${url(pages, lang)}">`,
    `<meta property="og:image" content="${SITE}${p.image}">`,
    '<meta property="og:image:type" content="image/webp">',
    `<meta property="og:image:width" content="${IMG.w}">`,
    `<meta property="og:image:height" content="${IMG.h}">`,
    `<meta property="og:image:alt" content="${attr(p.imageAlt)}">`,
    `<meta property="og:locale" content="${p.locale}">`,
    `<meta property="og:locale:alternate" content="${o.locale}">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ];
};

/**
 * 网站上蓝图生成器的一个入口：page 是打包好的页面（模板填好脚本），lang 'zh' | 'en'。英文那份放在 en/ 里（文件名同中文那份）：网站图标、icons/ 往上一层找。
 */
export function sitePage(page, lang) {
  const p = GEN[lang];
  const up = lang === 'en' ? '../' : '';
  let s = page;
  if (lang === 'en') {
    const zhTitle = /<title>([^<]*)<\/title>/.exec(s)[1];
    s = must(s, '<html lang="zh-CN">', `<html lang="en" data-zh-title="${attr(zhTitle)}">`);
    s = must(s, `<title>${zhTitle}</title>`, `<title>${attr(p.title)}</title>`);
    s = must(s, "/*__LANG__*/'auto'", "'en'");
    s = must(s, '<link rel="icon" href="favicon.ico">', '<link rel="icon" href="../favicon.ico">');
  }
  s = must(s, "/*__ROOT__*/''", JSON.stringify(up));
  s = must(s, '/*__ALT__*/null', JSON.stringify({ lang: OTHER[lang], href: lang === 'en' ? '../' : GEN.en.path }));
  const icon = `<link rel="icon" href="${up}favicon.ico">`;
  return must(s, icon, `${icon}\n${headTags(GEN, lang).join('\n')}`);
}

/**
 * 网站上量产计算器的一个入口：html 是 web/calc/index.html。中文的在 calc/（计算器的脚本、图集都放这里），英文的在 en/calc/，
 * 脚本和图集回 calc/ 找；网站图标在根目录。「生成蓝图」开同语言的生成器（上一层的 index.html），语言按钮在两个入口之间跳。
 */
export function calcPage(html, lang) {
  const p = CALC[lang];
  const up = lang === 'en' ? '../../' : '../'; // 到网站根目录
  const lib = lang === 'en' ? '../../calc/' : ''; // 到 calc/
  let s = html;
  if (lang === 'en') {
    const zhTitle = /<title>([^<]*)<\/title>/.exec(s)[1];
    s = must(s, '<html lang="zh-CN" class="boot">', `<html lang="en" class="boot" data-zh-title="${attr(zhTitle)}">`);
    s = must(s, `<title>${zhTitle}</title>`, `<title>${attr(p.title)}</title>`);
    s = must(s, "/*__LANG__*/'auto'", "'en'");
    for (const f of ['dsq-data.js', 'calc-icons.js', 'calc.js']) s = must(s, `<script defer src="${f}"></script>`, `<script defer src="${lib}${f}"></script>`);
    s = must(s, '<link rel="preload" href="calc-icons.avif"', `<link rel="preload" href="${lib}calc-icons.avif"`);
    s = must(s, 'url(calc-icons.webp);', `url(${lib}calc-icons.webp);`);
    s = must(s, 'image-set(url(calc-icons.avif) type("image/avif"), url(calc-icons.webp) type("image/webp"))', `image-set(url(${lib}calc-icons.avif) type("image/avif"), url(${lib}calc-icons.webp) type("image/webp"))`);
  }
  s = must(s, '<img class="logo" src="favicon.ico"', `<img class="logo" src="${up}favicon.ico"`);
  s = must(s, '/*__ALT__*/null', JSON.stringify({ lang: OTHER[lang], href: lang === 'en' ? '../../calc/' : '../en/calc/' }));
  s = must(s, "/*__GEN__*/'generator.html'", JSON.stringify('../index.html'));
  const desc = /<meta name="description" content="[^"]*">\n/.exec(s);
  if (!desc) throw new Error('没找到计算器原来的 description');
  s = s.replace(desc[0], ''); // 换成下面网站的那句
  const icon = '<link rel="icon" href="favicon.ico">';
  return must(s, icon, `<link rel="icon" href="${up}favicon.ico">\n${headTags(CALC, lang).join('\n')}`);
}

/** 网站根目录的 sitemap.xml */
export const sitemap = () =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...[GEN, CALC].flatMap((pages) =>
      Object.keys(pages).flatMap((l) => ['  <url>', `    <loc>${url(pages, l)}</loc>`, ...alternates(pages, 'xhtml:link').map((x) => `    ${x}`), '  </url>']),
    ),
    '</urlset>',
    '',
  ].join('\n');

/** 网站根目录的 robots.txt */
export const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`;
