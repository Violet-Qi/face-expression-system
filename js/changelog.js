/* ============================================================
   更新公告（v1.9 Next）
   ------------------------------------------------------------
   入口在封面右下角，**不主动弹出** —— 想看的人自己点。
   （用户明确要求：不搞主动弹窗，留个小按钮就行。）

   数据放在这里而不是去 fetch 更新公告.md：
     ① 交付包要能离线打开，fetch 外部 md 在多一层路径下容易失败；
     ② md 解析要再写个解析器，为了一个静态列表不值当。

   维护方式：加版本时在 CHANGELOG 数组最前面插一条即可。
   字段：ver 版本号 | date 日期 | title 一句话标题 | items 条目（支持 **加粗**）
   ============================================================ */

const CHANGELOG = [
  {
    ver: 'v1.9 Next', date: '11-23',
    title: '多一双眼睛，看同一张脸',
    items: [
      '多了一个**实验窗口「异构双引擎级联」**：一套判断这是什么表情，另一套说这个表情**有多用力** —— 嘴角扬了多少、眼周松不松；它标着「实验功能 · 未参与正式统计」，先尝尝鲜，判断不搅进正式统计里',
      '图片识别页**重排了**：识别完的结果直接盖在上传区上面，左上角一个「← 返回上传图片」；右边的信息框跟左边**一样高**，不用来回找',
      '选好图片时，上传区会**平滑地展开**到合适的高度；换一张、清空，也一样收放，不再“啪”地跳一下',
      '手机上的**模式条不再折行**：四个标签一行排开，横着滑也不溢出屏幕',
      '顺手修掉几处**不声不响的小毛病**：结果图不出来、关掉登录窗后整页点不动、人物分组的彩框不上色、「阈值对比实验」按钮自己消失',
      '性能档位菜单的**底板加厚**了，背后的字不再糊上来；界面整体沿用 1.9.5 的**简洁通透**，主题色切换恢复可用',
      '**「Next」是 1.9 系列的最后一版**，全新的视觉与体验留给 2.0 —— **敬请期待**'
    ]
  },
  {
    ver: 'v1.9.5', date: '11-18',
    title: '断网的时候，它也还在',
    items: [
      '**可以装到桌面了**：桌面出现千颜万花的图标，点开是全屏，没有浏览器地址栏',
      '**断网也能用**：第一次打开会把核心文件存在本机，之后拔掉网线照样能识别',
      '手机上从桌面图标打开时，版本号会显示 **v1.9.5(p)** —— 一眼看出是应用版',
      '内容更新了**会自动生效**，不用手动清缓存',
      '装了桌面版之后，只有访客统计需要联网，识别本身完全离线'
    ]
  },
  {
    ver: 'v1.9.4', date: '11-13',
    title: '别让东西被自己的影子挡住',
    items: [
      '修：**封面点「更新公告」没反应** —— 弹层其实打开了，只是被封面盖住看不见。'
      + '现在弹层会正确显示在最上层',
      '公告补全到 **v1.0 起的全部 19 个版本**（之前只到 v1.5）'
    ]
  },
  {
    ver: 'v1.9.3', date: '11-13',
    title: '按下去，就该有回声',
    items: [
      '**更新公告放到了封面右下角**，不主动打扰，想看的自己点开',
      '修：**点按钮时它会突然变大又缩回去**（水波把按钮撑开了，已收住）',
      '修：**打开弹窗时整页会往左平移一下**（滚动条占位没算好，已固定）',
      '修：**底部那个橙色按钮按下去没有反应**（入场动画压住了按下效果）',
      '设置里**删掉了跟页头重复的两个入口**，只留真正需要设置的东西'
    ]
  },
  {
    ver: 'v1.9.2', date: '11-13',
    title: '指尖落下，水面就醒了',
    items: [
      '修好**手机上看不全的档位菜单**：以前点右上角 ⚡，菜单会跑到屏幕外面，现在完整显示',
      '**登录支持邮箱**：注册时填的邮箱可以直接当账号用，不用记用户名',
      '**输错时能看懂错在哪**：用户名不存在 / 密码不正确 / 账号已被停用，三种提示各不相同',
      '**点哪儿都有水波反馈**：按下的位置扩散一圈涟漪，像水滴落进水面',
      '那些匀速直线、看着发僵的变化，现在都有自然的快慢节奏',
      '手机注册时，**输入时的键盘不再自己弹回去了**',
      '设置里的**档位卡片不再挤成一列一个字**',
      '登录失败时，**按钮不会再卡在「登录中…」**'
    ]
  },
  {
    ver: 'v1.9.1', date: '11-11',
    title: '把重的，也交给掌心',
    items: [
      '手机选增强模型时，会先告诉你**要下载约 28 MB，建议连 WiFi**，由你决定，不再直接拒绝',
      '用摄像头时**自动换回快速模型**，因为增强模型跟不上画面，看起来会卡',
      '手机右上角恢复档位入口（只显示图标），一样能切换',
      '修好一个以前设了不生效的开关'
    ]
  },
  {
    ver: 'v1.9.0', date: '11-11',
    title: '让飘忽的，落定',
    items: [
      '**表情标签稳定了**：以前同一个表情会在「高兴/中性」之间一秒跳十几次；现在同样情况下只跳一次，而真的变表情时 1.2 秒内就能跟上',
      '**页头可以直接换档位**：右上角「⚡ 速度优先 ▾」点一下就换，不用再进设置里翻',
      '**多了一个更准的表情模型**（增强版，18.4 MB，第一次用需要下载），只在电脑上开放',
      '设置里多了两个可调项：平滑强度、稳定度'
    ]
  },
  {
    ver: 'v1.8.2', date: '11-11',
    title: '把该在里面的，放回里面',
    items: [
      '**设置不再什么都塞**：从 9 组精简为 6 组，检测精度与分析工具移出为独立弹层',
      '修**卡片错位**：三档卡片在窄抽屉里被挤成「一列一个字」，改单列布局',
      '**文案精简**：三处长段落压缩，不必读整段',
      '修**手机注册时键盘自动收起**',
      '弹层统一锁背景滚动，居中精确到 0'
    ]
  },
  {
    ver: 'v1.8.1', date: '11-11',
    title: '收住那些过头的力气',
    items: [
      '**动画收敛**：过冲从 56% 降到 8%，位移从 120vw 收到 40vw，时长 320ms→240ms',
      '新增**检测器三档**：速度优先 / 均衡（SSD）/ 精度优先',
      '新增**模型注册表**：加模型只改一个文件',
      '管理台新增「改密」：可给任意用户重置密码'
    ]
  },
  {
    ver: 'v1.8.0', date: '11-11',
    title: '把看不见的摆上台面',
    items: [
      '新增**诊断面板**：后端、模型状态、输入尺寸、单帧耗时、本机编号',
      '新增**阈值对比实验**：同一张图跑三档阈值，出检出数、耗时、各脸置信度',
      '主题切换时「中间那些框」也跟着变色',
      '修：**登录永远卡在「登录中…」**'
    ]
  },
  {
    ver: 'v1.7.3', date: '11-11',
    title: '换上你喜欢的颜色',
    items: [
      '新增**四套主题色**：默认橙 / 向日葵黄 / 海洋蓝 / 樱花粉',
      '弹窗与抽屉关闭时增加退场动画',
      '修：**手机端登录按钮点不动**',
      '修：主题刷新后丢失'
    ]
  },
  {
    ver: 'v1.7.2', date: '11-10',
    title: '让每个动作都有回应',
    items: [
      '**全站非线性动效**：封面四字从四面飞入、面板左右飞入、弹窗过冲弹出',
      '修：登录弹窗不居中（偏 183px）、手机弹窗不贴底、游客次数不更新'
    ]
  },
  {
    ver: 'v1.7.0', date: '11-10',
    title: '从一个人用，到许多人来',
    items: [
      '品牌化：定名「千颜万花」，六瓣花 logo',
      '**账号体系**：注册 / 登录 / 停用，密码加盐哈希；未登录可**游客体验 1 次**',
      '**管理台用户管理**：列表、新建、删除、停用、详情',
      '**横向对比**与**纵向对比**'
    ]
  },
  {
    ver: 'v1.6.0', date: '11-09',
    title: '把固定的，交给使用者',
    items: [
      '新增**设置抽屉**：检测阈值、不确定阈值、摄像头频率三项可调',
      '匿名编号同步 + 设置分享链接'
    ]
  },
  {
    ver: 'v1.5.2', date: '11-09',
    title: '把漏掉的那一处补上',
    items: [
      '修：**摄像头切到视频页时主按钮没变灰**（分支漏写，改为统一收口）',
      '页眉加版本与更新日期；页脚加开源协议与部署环境说明'
    ]
  },
  {
    ver: 'v1.5.1', date: '11-09',
    title: '一次失手换来的谨慎',
    items: [
      '背景：部署后永久卡在「加载中」，控制台无报错 —— 静默失败',
      '资源加版本号杜绝旧缓存；封面加 30 秒看门狗'
    ]
  },
  {
    ver: 'v1.5', date: '11-08',
    title: '在开始之前，先留一扇门',
    items: [
      '新增**封面页**：点「开始体验」才进入，把模型加载的等待藏起来',
      '动效改用缓动，入场从四面八方飞入'
    ]
  },
  {
    ver: 'v1.4', date: '11-08',
    title: '让它也能被握在手里',
    items: [
      '**手机端响应式适配**：单列布局、吸底主按钮、触控友好尺寸',
      '局域网地址探测：启动后打印可访问地址，手机扫码即可打开',
      '实时请求日志、一键启动脚本'
    ]
  },
  {
    ver: 'v1.3', date: '11-08',
    title: '给作品装上一双眼睛',
    items: [
      '新增**零依赖 Node 后端**（只用内置模块，无需 npm）与**管理台**',
      '匿名统计上报：只发人脸数与表情计数，**不含图片、人脸框、特征**'
    ]
  },
  {
    ver: 'v1.2', date: '11-02',
    title: '从「看见」到「看懂」',
    items: [
      '**表情趋势折线图**与 CSV 导出',
      '**人物分组**（判断“像不像”，只给编号不给身份）、跨照片归属、多图批量识别'
    ]
  },
  {
    ver: 'v1.1', date: '10-21',
    title: '让被拍的人，也有体面',
    items: [
      '**人脸打码**：显示层马赛克，原图不变、不上传',
      '**视频文件逐帧分析**：输出“出现最多的表情”与逐帧统计'
    ]
  },
  {
    ver: 'v1.0', date: '10-09',
    title: '从一张空白开始',
    items: [
      '图片识别 + 摄像头实时识别，七类表情',
      '**纯前端架构**：模型与计算全在浏览器内，图片不出本机',
      '定下两条约束：检测输入尺寸必须 416；人脸特征只在内存、不落盘'
    ]
  }
];

/* ---------------- 渲染与开关 ---------------- */

/** 把 **文字** 转成 <b>，其余做 HTML 转义 */
function _clFormat(text) {
  const esc = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function renderChangelog() {
  const box = document.getElementById('changelogBody');
  if (!box || box.dataset.rendered === '1') return;
  box.innerHTML = CHANGELOG.map(e =>
    '<div class="cl-entry">' +
      '<div><span class="cl-ver">' + e.ver + '</span><span class="cl-date">' + e.date + '</span></div>' +
      '<p class="cl-title">' + _clFormat(e.title) + '</p>' +
      '<ul class="cl-list">' + e.items.map(i => '<li>' + _clFormat(i) + '</li>').join('') + '</ul>' +
    '</div>'
  ).join('');
  box.dataset.rendered = '1';
}

function openChangelog() {
  const mask = document.getElementById('changelogMask');
  const modal = document.getElementById('changelogModal');
  if (!mask || !modal) return;
  renderChangelog();
  /* V1.9.EXP：从触发按钮展开 */
  if (typeof openFromButton === 'function') {
    openFromButton(modal, mask);
    modal.setAttribute('aria-hidden', 'false');
    return;
  }
  mask.hidden = false;
  modal.hidden = false;
  requestAnimationFrame(() => {
    mask.classList.add('is-open');
    modal.classList.add('is-open');
  });
  modal.setAttribute('aria-hidden', 'false');
  if (typeof lockPageScroll === 'function') lockPageScroll(true);
}

function closeChangelog() {
  const mask = document.getElementById('changelogMask');
  const modal = document.getElementById('changelogModal');
  if (!mask || !modal || modal.hidden) return;
  if (typeof closeFromButton === 'function') { closeFromButton(modal); return; }
  modal.classList.remove('is-open');
  mask.classList.remove('is-open');
  modal.classList.add('is-closing');
  mask.classList.add('is-closing');
  const done = () => {
    modal.classList.remove('is-closing');
    mask.classList.remove('is-closing');
    modal.hidden = true;
    mask.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    if (typeof lockPageScroll === 'function') lockPageScroll(false);
  };
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) done(); else setTimeout(done, 200);
}

function initChangelog() {
  if (initChangelog._done) return;
  initChangelog._done = true;

  const btn = document.getElementById('changelogBtn');
  if (btn) btn.addEventListener('click', openChangelog);

  const close = document.getElementById('changelogClose');
  if (close) close.addEventListener('click', closeChangelog);

  const mask = document.getElementById('changelogMask');
  if (mask) mask.addEventListener('click', closeChangelog);

  document.addEventListener('keydown', (e) => {
    const m = document.getElementById('changelogModal');
    if (e.key === 'Escape' && m && !m.hidden) { e.stopPropagation(); closeChangelog(); }
  }, true);
}
