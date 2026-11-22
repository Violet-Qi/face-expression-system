# 千颜万花 · Web 人脸表情识别系统

> 一个**纯前端**的浏览器人脸表情识别系统。
> 图片、摄像头、视频文件三种输入，识别 7 类表情，**全部在本机完成——照片不出本机**。

![版本](https://img.shields.io/badge/version-1.9.5-blue)
![隐私](https://img.shields.io/badge/隐私-照片不出本机-success)
![PWA](https://img.shields.io/badge/PWA-可安装_·_断网可用-purple)

---

## 这是什么

在浏览器里识别人脸表情，**不做任何服务端推理**。

```
三种输入源    图片（单张 / 批量） · 摄像头实时 · 视频文件逐帧
七类表情      中性 · 高兴 · 悲伤 · 愤怒 · 恐惧 · 厌恶 · 惊讶
隐私边界      模型与计算全在浏览器，图片 / 视频 / 特征不上传、不落盘
```

**"照片不出本机"不是一句承诺，而是网络层根本不存在这条链路。**
打开浏览器开发者工具的 Network 面板，识别全程只有模型文件的下载请求，没有任何图片上传。

---

## 版本历史

共 23 个版本（`v1.0` → `v1.9.5`），每个版本都有独立 tag。

```bash
git tag                    # 查看所有版本
git checkout v1.5          # 回到 v1.5 那一版
git log --oneline --all    # 看完整演进
```

| 版本 | 日期 | 做了什么 |
|---|---|---|
| `v1.0` | 10-09 | 从一张空白开始：纯前端识别主链路，定下隐私边界与关键参数 |
| `v1.1` | 10-21 | 人脸打码 + 视频文件逐帧分析 |
| `v1.2` | 11-02 | 趋势折线图、CSV 导出、人物分组、跨照片归属、批量识别 |
| `v1.3` | 11-08 | 零依赖 Node 后端 + 管理台，统计可持久化 |
| `v1.3.1` / `v1.4.x` | 11-08 | 手机适配、局域网访问、请求日志、一键启动脚本 |
| `v1.5` ~ `v1.5.2` | 11-08~09 | 封面页与动效；线上事故后加加载超时兜底与资源版本号 |
| `v1.6.0` | 11-09 | 设置层：判定参数可调、匿名编号同步、设置分享链接 |
| `v1.7.0` ~ `v1.7.3` | 11-10~11 | 账号体系、管理台用户管理、横纵向对比、品牌化、四套主题色、全站非线性动效 |
| `v1.8.0` ~ `v1.8.2` | 11-11 | 诊断面板、阈值对比实验、检测精度三档、设置精简 |
| `v1.9.0` ~ `v1.9.2` | 11-11~13 | 多帧平滑、页头档位下拉、增强表情模型（FERPlus）、手机端支持、点击水波反馈、邮箱登录 |
| `v1.9.3` ~ `v1.9.4` | 11-13 | 更新公告入口（封面右下角）、修按钮尺寸跳变 / 整页平移 / 橙色按钮无反馈 |
| `v1.9.5` | 11-18 | **PWA 化**：可安装到桌面、断网可用、三级缓存策略 |

> **注**：`v1.7.3` 没有单独的源码包（当时未单独打包），因此仓库中没有该 tag。
> 其内容（四套主题色）已被 `v1.8.0` 包含。
>
> 每个版本的详细说明见 **[更新公告.md](更新公告.md)**。

---

## 快速开始

### 1. 克隆

```bash
git clone <仓库地址>
cd face-expression-system
```

### 2. 补上模型文件 ⚠️

**模型文件（30 MB）没有纳入版本控制**（避免仓库过重）。请按下表下载，放到 `models/` 目录：

| 文件 | 大小 | 来源 |
|---|---|---|
| `tiny_face_detector_model-weights_manifest.json` + `.bin` | 0.19 MB | [face-api.js models](https://github.com/justadudewhohacks/face-api.js/tree/master/weights) |
| `face_landmark_68_tiny_model-*` | 0.37 MB | 同上 |
| `face_expression_model-*` | 0.33 MB | 同上 |
| `ssd_mobilenetv1_model-*` | 5.4 MB | 同上（均衡 / 精度档用） |
| `face_landmark_68_model-*` | 0.35 MB | 同上 |
| `face_recognition_model-*` | 6.2 MB | 同上（人物分组用） |
| `emotion-ferplus-12-int8.onnx` | 18.4 MB | [ONNX Model Zoo](https://github.com/onnx/models)（可选，增强表情模型） |

**最小可用**：只下载前 3 项（约 0.9 MB）就能跑图片 / 摄像头识别。

`lib/onnxruntime/`（10.6 MB，增强模型用）同样需要单独补：
从 [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) 取 `ort.min.js` + `ort-wasm-simd.wasm`。

### 3. 启动

```bash
node server-app.js          # 默认 8000 端口
node server-app.js 8080     # 指定端口
```

或者 Windows 下双击 **`启动.bat`**。

打开 `http://127.0.0.1:8000` 即可。

> **需要 Node ≥ 22.5**（用到内置的 `node:sqlite`，无需 `npm install`）。

---

## 技术栈

```
前端      原生 JavaScript（20 个模块，无打包工具，全局作用域协作）
推理      face-api.js 1.7.15（内置 TensorFlow.js），WebGL 优先 / CPU 兜底
后端      server-app.js —— 零第三方依赖，只用 Node 内置模块
          node:http / node:sqlite / node:crypto / node:fs
数据库    SQLite（sessions / expr_items / users / device_settings / guest_trials）
PWA       manifest.json + sw.js（三级缓存：核心预缓存 / 按需 / 不缓存）
部署      Nginx + HTTPS
```

**为什么用零依赖后端**：不需要 `npm install`，没有依赖漏洞，任意一台机器上 `node server-app.js` 就能跑。

---

## 隐私设计（本项目的核心）

| 数据 | 处理方式 |
|---|---|
| 图片 / 视频 / 摄像头画面 | **不上传、不落盘**，仅内存中处理，刷新即清空 |
| 人脸特征（128 维） | **只在内存**临时用于"像不像"判断，不存储 |
| 匿名统计 | 只上报**计数**（人脸数、各表情次数、耗时），不含图片、人脸框、特征 |
| 设备设置同步 | 只存一个**前端生成的随机 UUID** + 几个数字参数 |
| 游客计数 | 随机 UUID，**刻意不使用 IP 或设备指纹** |
| 账号密码 | scrypt 加盐哈希（`salt:hash`），验证用恒定时间比较 |

**为什么游客计数不用 IP**：IP 在公共网络 / 移动网络下不可靠（多设备共用出口、换基站即变），
且属于个人信息。为一道使用门槛去采集它并不划算。代价是清缓存可绕过——但它是使用门槛，不是安全防线。

---

## 项目结构

```
├── index.html              主页面（封面 + 三页容器 + 弹层）
├── admin.html              管理台
├── server-app.js           后端（静态资源 + API 一体）
├── manifest.json           PWA 清单
├── sw.js                   Service Worker
├── css/
│   ├── style.css           主样式（含主题系统与动效）
│   └── admin.css           管理台样式
├── js/                     20 个模块
│   ├── main.js             事件绑定 / 模式切换 / 视图渲染唯一入口
│   ├── config.js           常量与全局状态
│   ├── models.js           后端选择与模型加载
│   ├── recognize.js        检测流水线 / 批量 / 分组
│   ├── render.js           画布绘制 / 检测框 / 脱敏
│   ├── camera.js           摄像头实时（抽帧 + 平滑）
│   ├── video.js            视频逐帧分析
│   ├── smoothing.js        多帧平滑（EMA + 迟滞）
│   ├── expression-engine.js 表情引擎适配（内置 / 增强）
│   ├── auth.js             账号体系
│   ├── settings.js         设置与持久化
│   ├── diagnostics.js      诊断面板与阈值实验
│   ├── stats-trend.js      统计与趋势
│   ├── report.js           CSV 导出
│   ├── grouping.js         人物分组
│   ├── image-select.js     图片选择
│   ├── ripple.js           点击水波
│   ├── changelog.js        更新公告
│   ├── pwa.js              PWA 安装与离线
│   └── model-registry.js   模型注册表
├── lib/                    face-api.js 等库
├── models/                 模型文件（⚠️ 未纳入版本控制）
├── docs/                   文档与截图
└── tests/                  测试素材
```

---

## 关键参数（改之前请先看这里）

```
INPUT_SIZE = 416          检测网络输入尺寸
                          ⚠️ 改成 512 会一张脸都检不出来（锚框尺度与 416 配套训练）
scoreThreshold  默认 0.50  调低到 0.30 能多检出小脸，但也会把背景认成脸
多帧平滑        alpha 0.40 / 迟滞 2 帧   抑制逐帧标签抖动
```

---

## 文档

| 文档 | 说明 |
|---|---|
| [更新公告.md](更新公告.md) | 每个版本做了什么（人话版） |
| [使用说明.md](使用说明.md) | 怎么用这个系统 |
| [代码导读.md](代码导读.md) | 各模块职责与阅读顺序 |

---

## 已知不足

- **识别准确率未做量化评测**：只有单图阈值对比实验，没有带标注的测试集与混淆矩阵
- **界面未经专业设计**：视觉方案由实现者自行判断
- **移动端性能未做基准**：只验证可用，没有帧率 / 内存数据
- **账号体系缺少配套**：没有密码找回、邮箱验证、第三方登录

---

## 许可证

本项目代码供学习与参考。

使用到的第三方库：
- [face-api.js](https://github.com/justadudewhohacks/face-api.js) —— MIT
- [TensorFlow.js](https://www.tensorflow.org/js) —— Apache-2.0
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) —— MIT

---

**千颜万花** —— 一千张脸，一万种表情。
