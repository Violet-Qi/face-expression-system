/* ============================================================
   config.js —— 配置与状态
   ------------------------------------------------------------
   本文件只放"数据"，不放逻辑：
     · 全局配置常量（模型地址、检测参数、表情中英对照、分组阈值…）
     · 运行状态变量（当前图片、分组结果、统计、趋势数据…）
     · DOM 元素引用
   其它文件都从这里取用，所以它必须最先加载。
   ============================================================ */

/* ============================================================
   基于Web平台的人脸表情识别系统 —— 主逻辑
   ------------------------------------------------------------
   系统分两种工作模式：
     1) 图片识别：上传一张照片 → 检测人脸 → 识别表情 → 标注展示
     2) 摄像头实时：从摄像头取画面 → 连续检测 → 实时标注

   两种模式共用同一套模型和同一套"检测 → 分类"流程，
   区别只在于输入源是 <img> 还是 <video>。

   全部计算在浏览器本地完成（face-api.js + TensorFlow.js），
   图片和摄像头画面都不会上传到任何服务器。
   ============================================================ */

/* ---------------- 全局配置 ---------------- */
const MODEL_URL   = './models';   // 模型文件目录
const MAX_FILE_MB = 10;           // 上传大小上限

/* 检测网络输入尺寸：必须用 416！
   实测 512 会让 tinyFaceDetector 一张脸都检测不到（face-api 的已知坑），
   416 是该模型的默认值，也是唯一稳定的选择。 */
const INPUT_SIZE  = 416;
const SCORE_TH    = 0.50;         // 置信度阈值，低于此值不算人脸
const SAMPLE_URL  = 'samples/test-face.jpg';  // 示例图片

/* 摄像头连续检测的间隔（毫秒）。
   400ms 约等于每秒 2.5 次检测 —— 视频画面本身是流畅播放的，
   只有检测框按这个频率更新，所以调慢不会让画面变卡。
   想让框跟得更紧就调小，想更省 CPU 就调大。 */
const CAMERA_INTERVAL = 400;

/* 表情趋势最多保留多少个采样点（约合摄像头模式下 5 分钟）。
   超出后从最早的一个开始丢，保证内存和绘图耗时都不会无限增长。 */
const TREND_MAX = 300;

/* 趋势数据点之间至少要间隔多久才重画一次折线图（毫秒）。
   摄像头模式下约 2.5 次/秒采样，每来一个点就重画一次会白耗 CPU，
   折线图没必要跟得那么细，所以绘图单独限流。 */
const TREND_REDRAW_MS = 300;

/* 模型输出的 7 类表情 → 中文，以及统计图表用的颜色 */
const EXPR_CN = {
  uncertain: '不确定',   // 设置里开了「不确定阈值」且最高概率偏低时，整站显示这个
  neutral:   '中性',
  happy:     '高兴',
  sad:       '悲伤',
  angry:     '愤怒',
  fearful:   '恐惧',
  disgusted: '厌恶',
  surprised: '惊讶'
};
/* 模型真实输出的七类表情键。
   ⚠️ 统计、CSV、图例都必须用这份清单，**不能用 Object.keys(EXPR_CN)** ——
   EXPR_CN 里还多一个 'uncertain'，那是「设置里开了不确定阈值」时的显示用标签，
   不属于模型的输出，混进统计会让列数从 7 变 8、数据也对不上。 */
const EXPR_KEYS_7 = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];

const EXPR_COLOR = {
  uncertain: '#b9bec6',   // 灰色：表示「模型拿不准」，不属于七类表情
  neutral:   '#8a94a0',
  happy:     '#ff7a1a',
  sad:       '#4a90d9',
  angry:     '#d93a3a',
  fearful:   '#9b59b6',
  disgusted: '#6a9955',
  surprised: '#e8a33d'
};

/* ---------------- 人物分组（同一张照片里的同一人自动归组） ----------------
   说明：这一功能只回答"这几张脸像不像"，**不回答"这是谁"**。
   不做人脸库、不保存任何特征数据，所有比对都在当前这张图片的内存里完成。

   阈值 DATAGROUP_TH：两张脸特征向量的欧氏距离小于它，就判为同一人。
   128 维人脸特征向量的经验取值：同一人约 0.0~0.3，不同人约 0.7~1.1，
   中间 0.4~0.7 是过渡区。

   跨照片分组时同一人的距离会比同图比较更大（不同照片的拍摄角度、光线、
   检测框松紧都不同），实测有到 0.50 的情况（例如 01-单人脸 与 04-极小图片，
   后者只有 24×22 像素、特征很糊）。所以阈值取 0.50：既容得下跨照片的正常
   波动，又不会把不同的人（0.74 以上）误并。 */
const GROUP_TH = 0.50;

/* 分组配色：与表情配色刻意区分开，避免混淆 */
const GROUP_COLORS = [
  '#2f7fd8', '#d94f9c', '#0f9e8e', '#c2711a',
  '#7a5cd6', '#3f9c35', '#c0392b', '#5b6b7c'
];

/* ---------------- 运行状态 ---------------- */
let modelsReady  = false;   // 模型是否加载完成
let currentFile  = null;    // 图片模式下当前图片（File 对象或 URL 字符串）

/* 批量：images 是一次选中的全部图片，currentIdx 是当前正在看/识别的那一张。
   images 的元素形如： { file: File|null, url: string, name: string } */
let images       = [];
let currentIdx   = 0;
/* 批量识别的累计结果： { name, faces, top, groups, error } */
let batchResults = [];
let batchRunning = false;

/* 跨照片归属汇总用：每张照片检测到的人脸特征与框。
   形状： [ { idx, name, url, faces: [{ box, descriptor, exprName, exprValue }] } ]
   —— 这些特征只在内存里临时存在，页面刷新即丢，不写入任何存储。 */
let photosData = [];
/* 跨照片聚类结果： { k, groups: [ { label, photos: [{idx, name, faceIdx, thumb}] } ], unassigned: [...] } */
let galleryData = null;
let busy         = false;   // 图片模式是否正在识别，防重复点击
let lastResults  = null;    // 最近一次识别结果，窗口缩放后用它重画
let lastInfoCostMs = 0;     // 最近一次识别耗时，切换分组开关后重绘信息区要用

let mode         = 'image'; // 当前模式：'image' | 'camera'
let cameraStream = null;    // 摄像头媒体流
let cameraAgg    = null;    // 本次摄像头会话的匿名统计累计（停止时上报）
let cameraTimer  = null;    // 连续检测的定时器
let cameraBusy   = false;   // 上一帧还没算完时跳过这一帧，避免任务堆积
let cameraFrames = 0;       // 用于计算帧率
let cameraFpsAt  = 0;

/* 累计统计：本次会话一共识别出多少张脸、各表情各多少张 */
const stats = {
  neutral: 0, happy: 0, sad: 0, angry: 0,
  fearful: 0, disgusted: 0, surprised: 0, total: 0
};
let statsLastAt = 0;   // 上次统计的时间点，用于摄像头模式限流（见 addStats）

/* 表情趋势：随时间记录"当前主导表情及其置信度"，用于画折线图。
   每个元素形如：
     { time, faces, dominant:{name,value}, exprName, exprValue, expr:{七类概率} }
   img/视频/时间戳由 recordTrend 内部自己获取，不用外面传。 */
let trendData  = [];
let trendStartAt = 0;   // 第一个采样点的时刻，时间轴以它为 0 秒

/* 趋势折线图的绘制数据缓存：只在数据变化时重算，窗口缩放时直接复用，
   这样 resize 重画既快又不会和上一次的曲线不一致。 */
let trendPlot   = null;
let trendRedrawTimer = null;

/* 人物分组：勾选后才会懒加载识别模型并计算 128 维特征 */
let groupEnabled  = false;   // 用户是否勾选了"自动识别人物分组"
let descriptorNetReady = false;  // 识别模型是否已加载
let lastGroups    = null;    // 最近一次的分组结果，resize 重画时要用

/* 人脸脱敏：开启后把画面上的人脸和所有小头像都做马赛克处理。
   只是"显示层"的处理 —— 原图不动、不上传、也不落盘。 */
let maskEnabled   = false;

/* 视频文件逐帧分析。
   trendTimeOverride 不为 null 时，趋势曲线的横轴改用这个值（毫秒），
   让时间轴表示"视频里播到第几秒"，而不是"我们跑了多久"。 */
let videoAnalyzing    = false;   // 是否正在分析
let videoAbortAt      = 0;       // 非 0 表示用户请求中止
let videoReady        = false;   // 是否已载入视频文件
let videoMeta         = null;    // { name, duration, width, height }
let videoSummary      = null;    // 分析结束后的汇总 { frames, faceFrames, faces, topName, topCount }
let trendTimeOverride = null;

/* ---------------- 视图状态 ----------------
   这里只放**推导不出来、必须显式记**的几项。
   其余显隐（有没有选图、是不是多张、有没有统计、有没有趋势、哪个模式…）
   由 js/main.js 的 renderView() 直接从上面的数据算出来。

   约定：业务函数只改数据 / 改这里的标志，**不要自己写 .hidden = ...**，
   最后调一次 renderView() 让界面跟上。
   —— 这样"界面长什么样"只在一个函数里决定，不会被十几个地方各改一遍。 */
const ui = {
  resultShown:  false,   // 右侧结果画布是否已切到「显示图片 + 画布」
  cameraLive:   false,   // 摄像头是否正在出画面
  videoShown:   false,   // 视频文件页是否已载入视频（显示画面而不是占位提示）
  groupShown:   false,   // 人物分组结果区是否显示
  galleryShown: false    // 跨照片归属汇总区是否显示
};

/* ---------------- DOM 引用 ---------------- */
const $ = id => document.getElementById(id);

/* 页面容器：图片页 / 摄像头页 / 视频文件页，由 renderView() 整块切换。
   这三个替代了以前零散的 leftPanel.hidden、workspace.classList('is-camera')、
   imageCanvasWrap.hidden、cameraCanvasWrap.hidden 等等。 */
const pageImage          = $('pageImage');
const pageCamera         = $('pageCamera');
const pageVideo          = $('pageVideo');

const modelStatus       = $('modelStatus');
const modelStatusText   = $('modelStatusText');
const tabImage          = $('tabImage');
const tabCamera         = $('tabCamera');
const tabVideo          = $('tabVideo');

/* ---- 视频文件页 ---- */
const videoFile         = $('videoFile');
const videoOverlay      = $('videoOverlay');
const videoInput        = $('videoInput');
const pickVideoBtn      = $('pickVideoBtn');
const videoStopBtn      = $('videoStopBtn');
const videoName         = $('videoName');
const videoBar          = $('videoBar');
const videoProgressWrap = $('videoProgressWrap');
const videoStats        = $('videoStats');
const videoPlaceholder  = $('videoPlaceholder');
const dropZone          = $('dropZone');
const dropInner         = $('dropInner');
const fileInput         = $('fileInput');
const sourceImg         = $('sourceImg');
const maskOverlay       = $('maskOverlay');
const video             = $('video');
const resultImg         = $('resultImg');
const overlay           = $('overlay');
const resultPlaceholder = $('resultPlaceholder');
const cameraOverlay     = $('cameraOverlay');
const cameraPlaceholder = $('cameraPlaceholder');
const infoTitle         = $('infoTitle');
const infoContent       = $('infoContent');
const statsBox          = $('statsBox');
const statsTotal        = $('statsTotal');
const statsContent      = $('statsContent');
const detectBtn         = $('detectBtn');
const trendBox          = $('trendBox');
const trendCanvas       = $('trendCanvas');
const trendWrap         = $('trendWrap');
const trendEmpty        = $('trendEmpty');
const trendLegend       = $('trendLegend');
const trendTotal        = $('trendTotal');
const trendNote         = $('trendNote');
const trendCsvBtn       = $('trendCsvBtn');
const trendClearBtn     = $('trendClearBtn');
const groupToggle       = $('groupToggle');
const maskToggle        = $('maskToggle');
const reportToggle      = $('reportToggle');
const imgBar            = $('imgBar');
const imgIndex          = $('imgIndex');
const prevBtn           = $('prevBtn');
const nextBtn           = $('nextBtn');
const replaceBtn        = $('replaceBtn');
const clearImgBtn       = $('clearImgBtn');
const batchPanel        = $('batchPanel');
const batchText         = $('batchText');
const batchBtn          = $('batchBtn');
const batchBar          = $('batchBar');
const batchStats        = $('batchStats');
const batchCsvBtn       = $('batchCsvBtn');
const groupBox          = $('groupBox');
const groupCards        = $('groupCards');
const groupCount        = $('groupCount');
const groupNote         = $('groupNote');
const galleryWrap       = $('galleryWrap');
const galleryGrid       = $('galleryGrid');
const galleryNote       = $('galleryNote');
const galleryPhotoCount = $('galleryPhotoCount');
const galleryPersonCount= $('galleryPersonCount');

/* 封面（进去之前那一屏） */
const cover             = $('cover');
const coverStart        = $('coverStart');
const coverStatus       = $('coverStatus');

