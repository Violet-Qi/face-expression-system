/* ============================================================
   模型注册表（v1.8.1）
   ------------------------------------------------------------
   为什么要有这个文件：
     之前"加一个模型"要改 4 处 —— config.js 的档位表、models.js 的加载分支、
     index.html 手写的三张卡片、settings.js 的白名单。
     现在全部从这一张表驱动：**加模型只改这个文件**。

   为什么不做成"服务端模型调度"那种完整注册表：
     我们的推理全在浏览器里，服务器只发静态文件，没有多模型调度需求。
     所以这里只做"前端可选项登记"，不做路由、权重、健康检查那些东西 ——
     那是 vLLM / Triton 那种服务端推理框架该干的事，用在这儿是过度设计。

   ⚠️ 加新模型时要注意的 4 件事（都在这张表里表达）：
     1. models/ 目录里要有对应的 manifest + bin
     2. detectNet 必须是 face-api 支持的键（tinyFaceDetector / ssdMobilenetv1 / mtcnn …）
     3. 如果换了检测器类型，models.js 的 buildDetectOptions() 要认识它的选项类
     4. 首次加载体积变了，extraMB 要跟着改 —— 用户看到的是这个数字
   ============================================================ */

/**
 * 检测器登记表。
 * 每一项是一档"检测精度"，不是一个独立模型 —— 一档可能用到多个网络。
 *
 * 字段说明：
 *   key         设置里存的值，也是 UI 的 data-preset
 *   name        显示名
 *   detectNet   用哪个检测网络（face-api 的 nets 键名）
 *   landmarkNet 用哪个关键点网络；'faceLandmark68Net' = 完整版，tiny 版更省
 *   desc        一句话说明，卡片上显示
 *   speedHint   耗时提示，卡片右侧显示
 *   extraMB     首次加载需要额外下载的体积（0 = 已内置）
 *   nets        这一档需要加载哪些网络（models.js 按这个列表加载）
 */
const MODEL_REGISTRY = [
  {
    key: 'speed',
    name: '速度优先',
    detectNet: 'tinyFaceDetector',
    landmarkNet: 'faceLandmark68TinyNet',
    desc: '快，适合摄像头实时；小脸与侧脸容易漏',
    speedHint: '单帧约 15~50 ms',
    extraMB: 0,
    nets: ['tinyFaceDetector', 'faceLandmark68TinyNet']
  },
  {
    key: 'balanced',
    name: '均衡',
    detectNet: 'ssdMobilenetv1',
    landmarkNet: 'faceLandmark68TinyNet',
    desc: '小脸、侧脸检出率明显更高；速度慢 4~8 倍',
    speedHint: '单帧约 80~200 ms',
    extraMB: 5.5,
    nets: ['ssdMobilenetv1', 'faceLandmark68TinyNet']
  },
  {
    key: 'accurate',
    name: '精度优先',
    detectNet: 'ssdMobilenetv1',
    landmarkNet: 'faceLandmark68Net',
    desc: '检测用 SSD、关键点用完整 68 点模型；最准也最慢',
    speedHint: '单帧约 120~300 ms',
    extraMB: 5.9,
    nets: ['ssdMobilenetv1', 'faceLandmark68Net']
  }
];

/* ---------------- 以下都是从注册表派生的，不要手写 ---------------- */

/** 所有合法档位的 key（设置校验用它） */
const DETECT_PRESET_KEYS = MODEL_REGISTRY.map(p => p.key);

/** key → 档位对象 的查表 */
const DETECT_PRESETS = MODEL_REGISTRY.reduce((acc, p) => { acc[p.key] = p; return acc; }, {});

/** 默认档位 */
const DEFAULT_PRESET_KEY = MODEL_REGISTRY[0].key;

/** 某个网络属于「已内置」还是「按需下载」 */
const BUILTIN_NETS = ['tinyFaceDetector', 'faceLandmark68TinyNet', 'faceExpressionNet'];

/** 按档位取需要加载的额外网络（排除已内置的与表情模型） */
function netsToLoadFor(presetKey) {
  const p = DETECT_PRESETS[presetKey];
  if (!p) return [];
  return (p.nets || []).filter(n => BUILTIN_NETS.indexOf(n) < 0);
}
