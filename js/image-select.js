/* ============================================================
   image-select.js —— 图片选择与换图
   ------------------------------------------------------------
   负责"用户选了哪些图"，不参与识别：
     · 多选/拖拽入队、逐张校验（格式、大小），不合格的单独列出原因
     · 前后切换、点图换图、重新选择、清空
     · 批量面板的渲染（进度、汇总、导出按钮）
   ============================================================ */

/* ============================================================
   图片模式：选择与校验
   ============================================================ */

/**
 * 接收用户选择的一批文件（一次可以选多张）。
 * 逐张校验，通过的入队，不通过的单独列出原因 —— 不因为其中一张有问题
 * 就把整批都拒掉，那样用户体验很差。
 */
function acceptFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;

  const ok = [];
  const bad = [];

  files.forEach(f => {
    if (!f.type || !f.type.startsWith('image/')) {
      bad.push(`${f.name}（不是图片格式）`);
    } else if (f.size > MAX_FILE_MB * 1024 * 1024) {
      bad.push(`${f.name}（${(f.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_FILE_MB} MB）`);
    } else {
      ok.push({ file: f, url: URL.createObjectURL(f), name: f.name });
    }
  });

  if (!ok.length) {
    showInfo('没有可用的图片：' + bad.join('；'), true);
    return;
  }

  // 上一批的 blob URL 要释放，否则连续换图会一直占内存
  images.forEach(it => { if (it && it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url); });

  batchResults = [];          // 换了图，上一批的统计作废
  images = ok;
  currentIdx = 0;
  currentFile = ok[0].file;

  showImageAt(0);

  if (bad.length) {
    showInfo(`已载入 ${ok.length} 张图片。以下 ${bad.length} 张被跳过：` + bad.join('；'), true);
  }
}

/** 接收一个图片 URL（示例图片用）。URL 也放进队列，这样"换图"逻辑统一。 */
function acceptUrl(url) {
  batchResults = [];
  images = [{ file: null, url: url, name: url.split('/').pop() || url }];
  currentIdx = 0;
  currentFile = null;         // 用 URL 时没有 File 对象
  showImageAt(0);
}

/** 切换到队列里的第 idx 张图，并重置右侧结果区 */
function showImageAt(idx) {
  if (!images.length) return;
  currentIdx = Math.max(0, Math.min(idx, images.length - 1));
  const item = images[currentIdx];
  currentFile = item.file;

  // 高度过渡：记录当前高度（选图后 .drop-zone 会被图片撑高），先锁住避免闪
  const pageEl = document.getElementById('pageImage');
  const fromHeight = pageEl ? pageEl.offsetHeight : 0;
  if (typeof pinPageHeight === 'function') pinPageHeight(pageEl, fromHeight);

  sourceImg.src = item.url;
  const many = images.length > 1;
  imgIndex.textContent = many ? `第 ${currentIdx + 1} / ${images.length} 张` : '';

  // 右侧结果区回到"待识别"状态
  ui.resultShown = false;
  resultPlaceholder.innerHTML = '<p>图片已就绪，点击下方按钮开始识别</p>';

  infoContent.innerHTML = '<p class="info-empty">尚未开始识别。</p>';
  lastGroups = null;   // 换图片了，上一次的分组结果不能留给新图用
  lastResults = null;
  clearGroupCards();   // 换图时把人物分组卡片一起清掉，避免显示上一张图的人

  renderBatch();
  updateButtonState();
  renderView();        // 显隐统一交给 renderView（原来这里有 9 处 .hidden）

  // 等图片解码后，把 #pageImage 从旧高度平滑过渡到新高度（选图拉长动画）
  if (typeof animateImagePageHeight === 'function' && pageEl && fromHeight) {
    animateImagePageHeight(pageEl, fromHeight, 'sourceImg');
  }
}

/** 前后切换（到头的另一头回绕，省得用户点着点着发现按钮点了没反应） */
function gotoPrevImage() {
  if (images.length < 2) return;
  showImageAt((currentIdx - 1 + images.length) % images.length);
}
function gotoNextImage() {
  if (images.length < 2) return;
  showImageAt((currentIdx + 1) % images.length);
}

/** 清空已选图片，回到初始的拖拽/选择界面 */
function clearImages() {
  // 高度过渡：记录当前高度（清空后 .drop-zone 会缩回 min-height），先锁住避免闪
  const pageEl = document.getElementById('pageImage');
  const fromHeight = pageEl ? pageEl.offsetHeight : 0;
  if (typeof pinPageHeight === 'function') pinPageHeight(pageEl, fromHeight);

  images.forEach(it => { if (it && it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url); });
  images = [];
  currentIdx = 0;
  currentFile = null;
  batchResults = [];
  batchRunning = false;

  sourceImg.removeAttribute('src');

  // 结果框的尺寸是跟着图片比例变的（见 render.js 的 morphImageWrap），
  // 清空图片后要还原，否则下次打开还是一副被压扁的框
  if (overlay && overlay.parentElement) {
    overlay.parentElement.style.height = '';
    overlay.parentElement.style.minHeight = '';
  }

  ui.resultShown = false;
  resultPlaceholder.innerHTML = '<p>识别结果会显示在这里</p>';

  infoContent.innerHTML = '<p class="info-empty">尚未开始识别。</p>';
  lastResults = null;
  lastGroups = null;
  clearGroupCards();

  renderBatch();
  updateButtonState();
  renderView();        // 显隐统一交给 renderView（原来这里有 7 处 .hidden）

  // 把 #pageImage 从高度平滑过渡缩回（清空缩回动画）
  if (typeof animateImagePageHeight === 'function' && pageEl && fromHeight) {
    animateImagePageHeight(pageEl, fromHeight, 'sourceImg', 60);
  }
}

