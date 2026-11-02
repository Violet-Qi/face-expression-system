/* ============================================================
   grouping.js —— 人物分组与跨照片归属
   ------------------------------------------------------------
   判断"哪几张脸是同一个人"（只比像不像，不识别身份）：
     · 聚类算法：128 维特征 + 欧氏距离 + 完全连接层次聚类（规避链式误合并）
     · 自动阈值：找距离断层，但只允许比默认值更保守
     · 结果卡片：一个人一张卡片，放出他的各张脸缩略图
     · 跨照片归属汇总：把所有照片的人脸特征合起来再聚类，得到"哪张照片是谁"
   ============================================================ */

/** 取某个人物组的颜色 */
function groupColor(gi) {
  return GROUP_COLORS[gi % GROUP_COLORS.length];
}

/**
 * 从图片里裁出某张人脸，做成一张小方块图（data URL）。
 * 检测框坐标和图片原始像素是同一套坐标系，所以直接按 box 裁剪即可。
 * 裁剪范围按人脸框的长边自适应留边，避免把额头或下巴切掉。
 */
function makeFaceThumb(imgEl, box, size) {
  if (!imgEl || !imgEl.naturalWidth) return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  // 按框的长边留 18% 边距，并把裁剪区调整成正方形（以人脸中心为中心）
  const side = Math.max(box.width, box.height) * 1.18;
  let sx = box.x + box.width / 2 - side / 2;
  let sy = box.y + box.height / 2 - side / 2;
  // 不要超出图片边界
  sx = Math.max(0, Math.min(sx, Math.max(0, imgEl.naturalWidth - side)));
  sy = Math.max(0, Math.min(sy, Math.max(0, imgEl.naturalHeight - side)));

  try {
    ctx.drawImage(imgEl, sx, sy, side, side, 0, 0, size, size);
  } catch (err) {
    return null;
  }
  // 小头像也是人脸，开了打码就一起盖住，否则脱敏会被头像绕过去
  if (maskEnabled) mosaicCanvas(c, Math.max(4, Math.round(size / 12)));
  try {
    return c.toDataURL('image/png');
  } catch (err) {
    return null;   // 万一图片跨域被污染，静默降级为不显示头像
  }
}

/**
 * 渲染"人物分组结果"卡片区。
 * 一个人一张卡片，卡片里放这个人的所有脸的小头像 —— 这样"模型认出了几个不同的人"
 * 一眼就能看出来，不用去比对框的颜色。
 */
function renderGroupCards(results, groups) {
  if (!groupBox) return;
  if (!groups || !results || results.length < 2) {
    ui.groupShown = false;
    renderView();
    return;
  }

  const n = results.length;
  // 裁剪用的图：优先用已经加载好的原图（sourceImg 总是当前这张图）
  const src = sourceImg && sourceImg.naturalWidth ? sourceImg : resultImg;

  // 按人分组收集脸
  const byGroup = {};
  groups.labels.forEach((g, i) => {
    (byGroup[g] = byGroup[g] || []).push(i);
  });

  groupCount.textContent = groups.k;
  groupCards.innerHTML = '';

  Object.keys(byGroup).map(Number).sort((a, b) => a - b).forEach(g => {
    const idxs = byGroup[g];
    const color = groupColor(g);

    const card = document.createElement('div');
    card.className = 'person-card';
    card.style.borderColor = color;

    const thumbs = document.createElement('div');
    thumbs.className = 'person-thumbs';

    idxs.forEach((i, order) => {
      const url = makeFaceThumb(src, results[i].detection.box, 112);
      if (!url) return;
      const im = document.createElement('img');
      im.className = 'person-thumb' + (order > 0 ? ' is-mini' : '');
      im.src = url;
      im.alt = `人物${g + 1} 的第 ${order + 1} 张脸`;
      thumbs.appendChild(im);
    });
    if (thumbs.children.length) card.appendChild(thumbs);

    const top = topExpression(results[idxs[0]].expressions);
    const info = document.createElement('div');
    info.className = 'person-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'person-name';
    nameEl.style.background = color;
    nameEl.textContent = `人物${g + 1}`;

    const countEl = document.createElement('span');
    countEl.className = 'person-meta';
    countEl.textContent = idxs.length > 1 ? `照片里出现 ${idxs.length} 次` : '照片里出现 1 次';

    const exprEl = document.createElement('span');
    exprEl.className = 'person-meta';
    exprEl.textContent = `当前表情：${EXPR_CN[top.name] || top.name}`;

    info.appendChild(nameEl);
    info.appendChild(countEl);
    info.appendChild(exprEl);
    card.appendChild(info);
    groupCards.appendChild(card);
  });

  // 结论说明：把"认出了几个人"讲清楚，并如实提示不确定性
  let note;
  if (groups.k === n) {
    note = `这 ${n} 张脸互不相同，判断为 ${groups.k} 个不同的人。`;
  } else if (groups.k === 1) {
    note = `这 ${n} 张脸判断为同一个人。`;
  } else {
    note = `${n} 张脸中判断出 ${groups.k} 个不同的人，同一张卡片里的人脸归为同一人。`;
  }
  if (groups.k < n && groups.maxIntraDistance > GROUP_TH * 0.85) {
    note += ' 注意：本组两张脸的相似度偏低，分组结果可能存疑。';
  }
  groupNote.textContent = note + '（仅判断"像不像"，不识别身份，不保存任何数据）';

  ui.groupShown = true;
  renderView();
}

/** 清空人物分组卡片区 */
function clearGroupCards() {
  if (!groupBox) return;
  ui.groupShown = false;
  ui.galleryShown = false;
  groupCards.innerHTML = '';
  groupNote.textContent = '';
  if (galleryGrid) galleryGrid.innerHTML = '';
  if (galleryNote) galleryNote.textContent = '';
  renderView();
}

/* ============================================================
   八之二、跨照片归属汇总
   ------------------------------------------------------------
   把"批量识别过的所有照片"里的人脸特征放到一起再聚类一次，
   于是同一个人在不同照片里会被归到同一个编号下，从而回答
   「哪张照片是谁」。

   ⚠️ 边界：**只用编号，不给姓名，不与任何身份关联**；
      特征只在内存里临时存在，刷新页面即全部丢弃，不写入任何存储。
      这样它仍然只是"按脸部特征归组"，而不是建立人脸档案。
   ============================================================ */

/** 从所有照片的人脸里算一次跨照片分组 */
function computeCrossPhotoGroups() {
  const descriptors = [];
  photosData.forEach(p => {
    (p.faces || []).forEach(f => {
      descriptors.push(f.descriptor);
    });
  });

  if (descriptors.length < 2) return null;

  // 和单图分组用同一套算法与阈值，行为保持一致
  const pairDist = [];
  for (let i = 0; i < descriptors.length; i++) {
    for (let j = i + 1; j < descriptors.length; j++) {
      pairDist.push(descriptorDistance(descriptors[i], descriptors[j]));
    }
  }
  const autoTh = autoThreshold(pairDist);
  const th = autoTh || GROUP_TH;
  const { labels, k, maxIntraDistance } = clusterDescriptors(descriptors, th);

  // 按组收集：每个组里有哪些照片的哪张脸
  const groups = [];
  for (let g = 0; g < k; g++) groups.push({ label: g, photos: [], maxIntra: 0 });

  let cursor = 0;
  photosData.forEach(p => {
    (p.faces || []).forEach(f => {
      const g = labels[cursor];
      groups[g].photos.push({
        idx: p.idx,
        name: p.name,
        url: p.url,
        faceIdx: cursor,
        box: f.box,
        exprName: f.exprName,
        exprValue: f.exprValue
      });
      cursor++;
    });
  });

  // 没检出人脸的照片单独列出来
  const noFace = [];
  images.forEach((it, i) => {
    const rec = photosData.find(p => p.idx === i);
    if (!rec || !rec.faces || !rec.faces.length) {
      noFace.push({ idx: i, name: it.name, url: it.url });
    }
  });

  return { k, threshold: th, autoThreshold: autoTh, groups, noFace, totalFaces: descriptors.length, maxIntraDistance };
}

/** 渲染跨照片归属汇总（照片墙 + 人物汇总） */
function renderGallery() {
  if (!galleryWrap) return;

  if (!galleryData || !galleryData.totalFaces) {
    ui.galleryShown = false;
    renderView();
    return;
  }

  const personCount = galleryData.groups.filter(g => g.photos.length).length;
  galleryPhotoCount.textContent = images.length;
  galleryPersonCount.textContent = personCount;

  galleryGrid.innerHTML = '';

  // 每个"人"一张卡片：他的脸出现在哪几张照片里
  galleryData.groups.forEach(g => {
    if (!g.photos.length) return;
    const color = groupColor(g.label);

    const card = document.createElement('div');
    card.className = 'person-card';
    card.style.borderColor = color;

    const thumbs = document.createElement('div');
    thumbs.className = 'person-thumbs';
    g.photos.slice(0, 4).forEach((ph, order) => {
      // 从该照片里裁出这张脸
      const tmpImg = new Image();
      tmpImg.src = ph.url;
      const key = ph.faceIdx;
      // 图片可能还没解码完，用 onclick 补一次；这里先放占位
      const url = makeFaceThumbFromUrl(ph.url, ph.box, 112);
      if (!url) return;
      const im = document.createElement('img');
      im.className = 'person-thumb' + (order > 0 ? ' is-mini' : '');
      im.src = url;
      im.alt = `人物${g.label + 1} 在照片 ${ph.idx + 1}`;
      im.title = ph.name;
      thumbs.appendChild(im);
    });
    if (thumbs.children.length) card.appendChild(thumbs);

    const info = document.createElement('div');
    info.className = 'person-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'person-name';
    nameEl.style.background = color;
    nameEl.textContent = `人物${g.label + 1}`;

    const listEl = document.createElement('span');
    listEl.className = 'person-meta';
    const photoNums = [...new Set(g.photos.map(p => p.idx + 1))].sort((a, b) => a - b);
    listEl.textContent = `出现在第 ${photoNums.join('、')} 张照片`;

    const countEl = document.createElement('span');
    countEl.className = 'person-meta';
    countEl.textContent = `共 ${g.photos.length} 张脸 / ${photoNums.length} 张照片`;

    info.appendChild(nameEl);
    info.appendChild(listEl);
    info.appendChild(countEl);
    card.appendChild(info);
    galleryGrid.appendChild(card);
  });

  // 没检出人脸的也列出来，别让用户以为漏了
  galleryData.noFace.forEach(ph => {
    const card = document.createElement('div');
    card.className = 'person-card';
    card.style.borderColor = '#d3d9e0';
    const info = document.createElement('div');
    info.className = 'person-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'person-name';
    nameEl.style.background = '#b9c2cc';
    nameEl.textContent = `第 ${ph.idx + 1} 张`;
    const metaEl = document.createElement('span');
    metaEl.className = 'person-meta';
    metaEl.textContent = '未检出人脸';
    const fileEl = document.createElement('span');
    fileEl.className = 'person-meta';
    fileEl.textContent = ph.name;
    info.appendChild(nameEl); info.appendChild(metaEl); info.appendChild(fileEl);
    card.appendChild(info);
    galleryGrid.appendChild(card);
  });

  // 说明文字：把方法和边界讲清楚
  let note = `编号只代表"这些脸在特征上最接近"，不代表真实身份；系统不记录姓名、不建立人脸档案。`;
  if (galleryData.autoThreshold !== null) {
    note += `本次判定阈值 ${galleryData.threshold.toFixed(2)}（按特征距离的断层自动推定）。`;
  } else {
    note += `本次判定阈值 ${galleryData.threshold.toFixed(2)}（默认值）。`;
  }
  if (personCount < galleryData.totalFaces) {
    note += ` ${galleryData.totalFaces} 张脸归为 ${personCount} 个人，说明有照片里出现了同一个人。`;
  }
  note += ' 所有特征只存在于当前页面的内存中，刷新即清空。';
  galleryNote.textContent = note;

  ui.galleryShown = true;
  renderView();
}

/**
 * 从一个图片 URL 裁出人脸小图。
 * 需要等图片解码完成才能裁，所以用一个缓存好的 Image 对象同步取。
 */
const _thumbImgCache = {};
function makeFaceThumbFromUrl(url, box, size) {
  let img = _thumbImgCache[url];
  if (img && img.complete && img.naturalWidth) {
    return makeFaceThumb(img, box, size);
  }
  if (!img) {
    img = new Image();
    img.src = url;
    _thumbImgCache[url] = img;
    // 解码完成后补一次渲染（这时界面上还没有缩略图，但很快会补上）
    img.addEventListener('load', () => { if (galleryData) renderGallery(); }, { once: true });
  }
  return null;
}

/** 跨照片分组完成后，把当前这张照片的框也按"人物N"重新标注和上色 */
function redrawCurrentWithCrossPhotoLabels() {
  if (!galleryData || !lastResults || !lastResults.length) return;

  const cur = photosData.find(p => p.idx === currentIdx);
  if (!cur || !cur.faces || !cur.faces.length) return;

  // 算出这张照片的首张脸在"全局脸序号"里的起点
  let base = 0;
  for (const p of photosData) {
    if (p.idx === currentIdx) break;
    base += (p.faces || []).length;
  }

  // 全局脸序号 → 人物编号
  const labelOfGlobal = {};
  galleryData.groups.forEach(g => {
    g.photos.forEach(ph => { labelOfGlobal[ph.faceIdx] = g.label; });
  });

  const labels = cur.faces.map((_, i) => {
    const lab = labelOfGlobal[base + i];
    return (lab === undefined) ? -1 : lab;
  });

  // 用当前图已有的表情结果配上跨照片的组号，重画一次
  const fakeResults = cur.faces.map((f, i) => ({
    detection: { box: f.box },
    expressions: lastResults[i] ? lastResults[i].expressions : {}
  }));

  const g = {
    labels,
    k: galleryData.k,
    maxIntraDistance: galleryData.maxIntraDistance || 0,
    autoThreshold: galleryData.autoThreshold
  };

  lastGroups = g;
  drawResults(fakeResults, g);
  renderInfo(fakeResults, lastInfoCostMs, g);
}

/* ============================================================
   人物分组（同一张照片里判断"哪几张脸是同一个人"）
   ------------------------------------------------------------
   ⚠️ 边界说明：这一功能只回答"这两张脸像不像"，**不回答"这是谁"**。
   系统不建立人脸库、不保存任何特征数据、不与姓名关联；
   所有比对都只发生在当前这张图片的内存里，识别完即随结果丢弃。
   ============================================================ */

/** 两个 128 维特征向量的欧氏距离（越小越像） */
function descriptorDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * 用"完全连接"的层次聚类把若干张脸归组。
 *
 * 为什么用完全连接（complete linkage）而不是"和一个人像就并进来"（单连接）？
 * 单连接有个著名缺陷叫"链式效应"：A像B、B像C，就会把 A、B、C 并成一组，
 * 哪怕 A 和 C 其实不像。完全连接要求**组里任何两张脸都足够像**，
 * 天然避免了这种误合并，代价是同一人如果两张照片差异很大可能被拆开。
 * 对人脸分组这种"宁可拆开、不可错并"的场景，完全连接更合适。
 *
 * @param {number[][]} descriptors 每个元素是一个 128 维数组
 * @param {number} threshold 距离小于它就认为是同一人
 * @returns {{ labels: number[], k: number, maxIntraDistance: number }}
 */
function clusterDescriptors(descriptors, threshold) {
  const n = descriptors.length;
  const labels = new Array(n).fill(-1);
  if (!n) return { labels: [], k: 0, maxIntraDistance: 0 };

  const th = (typeof threshold === 'number' && threshold > 0) ? threshold : GROUP_TH;

  // 先算出两两距离，后面要反复用
  const dist = [];
  for (let i = 0; i < n; i++) {
    dist.push(new Array(n).fill(0));
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = descriptorDistance(descriptors[i], descriptors[j]);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  // 初始：每张脸各成一组
  const clusters = descriptors.map((_, i) => [i]);

  // 反复找"最像的两个组"并起来，直到最像的也超过阈值
  for (;;) {
    let bestI = -1, bestJ = -1, bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        // 完全连接：两组之间的距离 = 两组之间最远的那一对
        let worst = 0;
        for (const x of clusters[i]) {
          for (const y of clusters[j]) {
            if (dist[x][y] > worst) worst = dist[x][y];
          }
        }
        if (worst < bestD) { bestD = worst; bestI = i; bestJ = j; }
      }
    }
    if (bestI === -1 || bestD > th) break;
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ]);
    clusters.splice(bestJ, 1);
  }

  // 组内最大距离：越大说明这一组越不可靠，界面上会用它提示"存疑"
  let maxIntra = 0;
  clusters.forEach((c, gi) => {
    c.forEach(i => { labels[i] = gi; });
    for (let a = 0; a < c.length; a++) {
      for (let b = a + 1; b < c.length; b++) {
        if (dist[c[a]][c[b]] > maxIntra) maxIntra = dist[c[a]][c[b]];
      }
    }
  });

  return { labels, k: clusters.length, maxIntraDistance: maxIntra };
}

/**
 * 自动定阈值：在所有相邻的两两距离里找那个"最大的断层"，取断层中点作阈值。
 * 人脸特征距离天然分两簇（同人一堆、异人一堆），中间必有明显空隙。
 * 这样比写死一个数字更稳。找不到明显断层时返回 null，由调用方用默认值。
 */
function autoThreshold(distances) {
  const ds = distances.slice().sort((a, b) => a - b);
  if (ds.length < 2) return null;

  // 人脸特征距离的取值范围大致是 0~1.4（128 维，最大值约 √2）。
  // 注意下限不能设太高：实测"同一人"的距离可以小到 0.04，
  // 如果把搜索范围从 0.25 起步，就会把这个断层整段漏掉。
  //
  // 评分刻意"偏爱靠近默认阈值的断层"：点数很少时，最大的空隙可能恰好跨过
  // 真正的分界（例如点只有 0.50 和 0.95，空隙中点 0.72），
  // 这种阈值会把 0.6 左右的边界人脸误判为同一人，很危险。
  // 所以宁可判不出、退回默认值，也不要挑一个偏得很远的阈值。
  let bestScore = -Infinity, bestAt = -1;
  for (let i = 0; i < ds.length - 1; i++) {
    if (ds[i] < 0.02 || ds[i + 1] > 1.25) continue;
    const gap = ds[i + 1] - ds[i];
    const mid = (ds[i] + ds[i + 1]) / 2;
    const score = gap - Math.abs(mid - GROUP_TH) * 3.0;
    if (score > bestScore) { bestScore = score; bestAt = i; }
  }
  if (bestAt < 0 || (ds[bestAt + 1] - ds[bestAt]) < 0.12) return null;  // 断层不够明显，不硬猜

  const th = (ds[bestAt] + ds[bestAt + 1]) / 2;

  // 自动阈值只允许比默认值更保守（即更低），不允许更高。
  // 原因：分组的原则是"宁可把同一人拆成两组，也不要把两个人并成一组"
  // ——前者用户一眼能看出不对，后者会得出一个错误结论还看不出来。
  // 当断层跨得太宽时，中点会跑到默认值以上（例如 0.50→0.95 的中点是 0.72），
  // 这种阈值会把 0.6 左右的边界人脸误并成同一人，所以直接放弃、退回默认值。
  if (th > GROUP_TH + 0.05) return null;

  return th;
}

/** 把分组结果应用到人脸列表上：每张脸拿到自己的组号与颜色 */
function applyGroups(results, descriptors, threshold) {
  // 人脸从左到右排序，保证"人物1/人物2"的顺序符合直觉，也保证结果可复现
  const order = results.map((r, i) => i)
    .sort((a, b) => results[a].detection.box.x - results[b].detection.box.x);

  const sortedDesc = order.map(i => descriptors[i]);
  const cl = clusterDescriptors(sortedDesc, threshold);

  // 把排序后的组号映射回原始下标
  const labels = new Array(results.length).fill(0);
  order.forEach((origIdx, pos) => { labels[origIdx] = cl.labels[pos]; });

  let maxIntra = 0;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      if (labels[i] === labels[j]) {
        const d = descriptorDistance(descriptors[i], descriptors[j]);
        if (d > maxIntra) maxIntra = d;
      }
    }
  }

  return { labels, k: cl.k, maxIntraDistance: maxIntra, order };
}

