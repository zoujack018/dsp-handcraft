// 公开网站四个入口页面底下的简介和常见问题（给新访客和搜索引擎看）。web/site.js 打包时按入口的语言放进页面，同时出 FAQPage 结构化数据。
// 中文、英文各写各的，同一页两种语言的问题条数、顺序要一样（test/site.test.js 查）。
// 写法：lead、a 是一段一个字符串的纯文字；只认一种标记 [文字](网址)，网址写相对这一页的（calc/ 在两种语言的入口上都对）或 https:// 开头的。
// 游戏里的按钮、科技名照游戏自带的文字写（粘贴蓝图代码 / Paste Blueprint Code，批量建造 / Mass Construction），页面上的按钮名照页面写。

const REPO = 'https://github.com/zoujack018/dsp-handcraft';
const DSQ = 'https://github.com/122474363/DSQ';

export const ABOUT = {
  // 蓝图生成器：/ 和 /en/
  gen: {
    zh: {
      title: '戴森球计划产线蓝图生成器',
      lead: [
        '选一个目标产物，填每分钟要多少，它就把整条产线排成一张蓝图：从矿到成品要几台熔炉、几台制造台都算好，传送带、分拣器、供电一起摆上，复制蓝图代码贴进游戏就能建。',
        '排法照玩家手搓的习惯：每种物品走自己的一条带，工厂一行一行排、行与行之间夹着传送带通道，分拣器都紧挨着工厂。免费，在浏览器里运行，不用安装也不用注册。',
      ],
      faqTitle: '常见问题',
      faq: [
        {
          q: '生成的蓝图怎么贴进游戏？',
          a: [
            '排好以后点「复制蓝图」，蓝图代码就在剪贴板里了。进游戏按 Ctrl+V 进入蓝图粘贴模式，在蓝图面板上点「粘贴蓝图代码」，再选位置建造。',
            '也可以在蓝图库里新建一个蓝图，粘贴代码后保存，以后随时取用。游戏里要先研究「批量建造」科技才有蓝图功能。',
          ],
        },
        {
          q: '能排哪些产线？',
          a: [
            '游戏里用工厂造的东西基本都能当目标：铁块、电路板、处理器，一直到六种矩阵（电磁矩阵、能量矩阵、结构矩阵、信息矩阵、引力矩阵、宇宙矩阵，也就是玩家说的蓝糖、红糖、黄糖、紫糖、绿糖、白糖）。一次可以加几个目标，排进同一张图。',
            '也能排重氢的分馏塔阵列。',
          ],
        },
        {
          q: '蓝图里用到的建筑我还没解锁，能换吗？',
          a: ['能。图纸上方那排按钮可以换传送带、分拣器、熔炉、制造台、化工厂、研究站的型号，选喷不喷增产剂，供电用电力感应塔还是卫星配电站，原料和成品走传送带、箱子还是物流站。照你存档里已经解锁的选就行。'],
        },
        {
          q: '能喷增产剂吗？',
          a: ['能。图纸上方最后一个按钮选增产剂的等级，蓝图里会带上喷涂机和给喷涂机送增产剂的传送带。'],
        },
        {
          q: '蓝图能贴在星球的什么位置？',
          a: ['产线里有化工厂、原油精炼厂时，默认的间距只适合贴在赤道附近。要贴到别的纬度，把左栏「化工厂、精炼厂高纬度间距展开」选成「开（任何纬度）」再生成。'],
        },
        {
          q: '贴的时候游戏说设施数量超了怎么办？',
          a: ['一张蓝图一次能建多少设施，由游戏里「批量建造」科技的级别决定，级别低时大蓝图贴不下。把这项科技升上去，或者把每分钟产量调小、分成几张排。'],
        },
        {
          q: '生成一张要等多久？',
          a: ['几十台的小产线几秒到几十秒，几百台的大产线要几分钟。点「生成蓝图」之前，按钮下面会写预计用时。「搜索力度」选「美观」会多花些时间，尽量把图排成和屏幕差不多的横向形状。'],
        },
        {
          q: '生成的蓝图靠得住吗？',
          a: ['每张蓝图出来以后都会另外检查一遍：建筑有没有相撞、传送带接没接上、分拣器够不够得着、电有没有供到，结果列在「检查」里。没通过的图页面会明说，不建议贴。'],
        },
        {
          q: '和从蓝图网站下载现成的蓝图有什么不同？',
          a: ['现成蓝图的产量和用的建筑是别人定的。这里按你要的每分钟产量、你已经解锁的建筑现排一张，不多不少。'],
        },
        {
          q: '免费吗？要联网吗？',
          a: [`免费，开源（GPL-3.0）。排布全在你自己的浏览器里算，不上传你的产线。想离线用，到 [GitHub](${REPO}) 下载整份，解压后打开 index.html 就行。`],
        },
        {
          q: '我只想算配比，不要蓝图',
          a: ['用[量产计算器](calc/)：选目标和每分钟产量，列出每种设备要几台、要多少原料、大约用多少电。算好的产线点「生成蓝图」就带回这里排。'],
        },
      ],
    },
    en: {
      title: 'Dyson Sphere Program Blueprint Generator',
      lead: [
        'Pick a product and how many you want per minute, and this tool lays out the whole production line as one blueprint. It works out how many smelters and assemblers you need from ore to finished product, places the belts, sorters and power, and gives you a blueprint code to paste into the game.',
        'The layout follows the way players build by hand: one belt per item, machines in rows with belt aisles between the rows, every sorter right next to its machine. Free, runs in your browser, no install and no account.',
      ],
      faqTitle: 'Questions and answers',
      faq: [
        {
          q: 'How do I get the blueprint into the game?',
          a: [
            'When the layout is done, click Copy blueprint; the blueprint code is now on your clipboard. In the game, press Ctrl+V to enter blueprint paste mode, click Paste Blueprint Code on the blueprint panel, then pick a spot and build.',
            'You can also create a new blueprint in the Blueprint Library, paste the code there and save it for later. Blueprints become available in the game once you have researched Mass Construction.',
          ],
        },
        {
          q: 'What can it lay out?',
          a: [
            'Almost anything made in a factory building: iron ingots, circuit boards, processors, all the way up to the six matrices (Electromagnetic, Energy, Structure, Information, Gravity and Universe Matrix, also known as blue to white science). You can add several targets and get them in one blueprint.',
            'It also makes fractionator arrays for deuterium.',
          ],
        },
        {
          q: 'I have not unlocked some of the buildings. Can I change them?',
          a: ['Yes. The buttons above the drawing let you pick the belt, sorter, smelter, assembler, chemical plant and lab, whether to use proliferator, Tesla Towers or Satellite Substations for power, and whether materials come and go by belt, storage or logistics stations. Choose what your save has unlocked.'],
        },
        {
          q: 'Does it support proliferator?',
          a: ['Yes. The last button above the drawing sets the proliferator grade. The blueprint then includes the spray coaters and the belts that feed them.'],
        },
        {
          q: 'Where on the planet can I paste it?',
          a: ['If the line has Chemical Plants or Oil Refineries, the default spacing only fits near the equator. To paste at other latitudes, set "High-latitude spacing for Chemical Plants and refineries" in the left panel to "Any latitude" before you generate.'],
        },
        {
          q: 'The game says the blueprint has too many facilities. What now?',
          a: ['How many facilities one blueprint can place is set by your Mass Construction research level, so a large blueprint will not fit at low levels. Research it further, or lower the rate per minute and build the line as several smaller blueprints.'],
        },
        {
          q: 'How long does it take?',
          a: ['A small line of a few dozen buildings takes seconds to tens of seconds; a few hundred buildings take minutes. The estimate is shown under the Generate blueprint button before you start. The Polished search effort takes longer and aims for a wide layout close to the shape of your screen.'],
        },
        {
          q: 'Can I trust the result?',
          a: ['Every blueprint is checked independently after it is generated: building collisions, belt connections, sorter reach and power coverage. The outcome is listed under Checks. If a layout fails, the page says so and you should not paste it.'],
        },
        {
          q: 'How is this different from downloading a ready-made blueprint?',
          a: ['A ready-made blueprint comes with someone else\'s output rate and choice of buildings. This tool lays out a line for exactly the rate you ask for, with the buildings you have unlocked.'],
        },
        {
          q: 'Is it free? Does it need a connection?',
          a: [`Free and open source (GPL-3.0). The layout is computed in your own browser and your production line is not uploaded. To use it offline, download the repository from [GitHub](${REPO}), unzip it and open en/index.html.`],
        },
        {
          q: 'I only want the ratios, not a blueprint',
          a: ['Use the [production calculator](calc/): pick targets and rates per minute and it lists how many of each building, how much raw material and roughly how much power you need. From there, Generate blueprint brings the line back here.'],
        },
      ],
    },
  },
  // 量产计算器：/calc/ 和 /en/calc/
  calc: {
    zh: {
      title: '戴森球计划量产计算器',
      lead: ['选目标物品和每分钟产量，算出整条线每种设备要几台、每种原料每分钟要多少、大约用多少电。算好的产线可以直接交给蓝图生成器，排成能贴进游戏的蓝图。免费，在浏览器里运行，不用安装也不用注册。'],
      faqTitle: '常见问题',
      faq: [
        {
          q: '怎么用？',
          a: ['左边加目标物品、填每分钟产量，右边就是生产清单：每样中间产物每分钟要多少、要几台设备。清单上方那排按钮换传送带、熔炉、制造台这些设备的型号和增产剂，数字跟着变。'],
        },
        {
          q: '「外部」是什么意思？',
          a: ['清单里不想自己造的东西，点那一行右边的「外部」，它就改成从别处运来，不再算它上游的设备和原料。'],
        },
        {
          q: 'D 和 S 两个模式有什么区别？',
          a: ['D 是需求模式，只算整条线要多少。S 是供给模式：每生成一张蓝图，它做的东西就标成已完成、从清单里扣掉，清单剩下的就是还要做的，适合把一条大产线分成几张蓝图慢慢建。'],
        },
        {
          q: '算好了怎么变成蓝图？',
          a: ['在清单里点选要做的物品（可以多选，它要用的东西一起做），点「生成蓝图」，[蓝图生成器](../)会在弹层里打开并填好这条线。点「生成无带蓝图」出的是无带流蓝图。'],
        },
        {
          q: '配方数据从哪来？',
          a: [`配方数据和界面来自[戴森球计划量产量化计算器（DSQ）](${DSQ})，开源（GPL-3.0）。`],
        },
      ],
    },
    en: {
      title: 'Dyson Sphere Program Production Calculator',
      lead: ['Pick target items and a rate per minute to see how many of each building the whole line needs, how much of each raw material per minute, and roughly how much power. You can hand the line straight to the blueprint generator and get a blueprint to paste into the game. Free, runs in your browser, no install and no account.'],
      faqTitle: 'Questions and answers',
      faq: [
        {
          q: 'How do I use it?',
          a: ['Add target items on the left and set a rate per minute. The production list on the right shows how much of every intermediate product you need per minute and how many buildings make it. The buttons above the list change the belt, smelter, assembler and other building tiers and the proliferator, and the numbers follow.'],
        },
        {
          q: 'What does External mean?',
          a: ['If you would rather not make something in the list yourself, click External at the right end of its row. It is then brought in from elsewhere, and the buildings and raw materials upstream of it are no longer counted.'],
        },
        {
          q: 'What is the difference between the D and S modes?',
          a: ['D is demand mode: it just shows what the whole line needs. S is supply mode: every time you generate a blueprint, what it makes is marked Done and taken off the list, so the list shows what is still left to build. That suits building a large line as several blueprints.'],
        },
        {
          q: 'How do I turn the result into a blueprint?',
          a: ['Click the items in the list that you want to build (you can pick several; what they use is built along with them), then click Generate blueprint. The [blueprint generator](../) opens in an overlay with the line filled in. Generate beltless blueprint makes a beltless layout instead.'],
        },
        {
          q: 'Where does the recipe data come from?',
          a: [`The recipe data and the interface come from [DSQ](${DSQ}), an open-source (GPL-3.0) Dyson Sphere Program calculator.`],
        },
      ],
    },
  },
};
