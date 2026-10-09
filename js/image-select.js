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

  sourceImg.src = item.url;
  sourceImg.hidden = false;
  dropInner.hidden = true;
  dropZone.classList.add('has-image');

  // 操作条：一张时不显示前后切换，多张时才显示
  imgBar.hidden = false;
  const many = images.length > 1;
  prevBtn.hidden = !many;
  nextBtn.hidden = !many;
  imgIndex.textContent = many ? `第 ${currentIdx + 1} / ${images.length} 张` : '';

  // 右侧结果区回到"待识别"状态
  resultImg.hidden = true;
  overlay.hidden = true;
  resultPlaceholder.hidden = false;
  resultPlaceholder.innerHTML = '<p>图片已就绪，点击下方按钮开始识别</p>';

  infoContent.innerHTML = '<p class="info-empty">尚未开始识别。</p>';
  lastGroups = null;   // 换图片了，上一次的分组结果不能留给新图用
  lastResults = null;
  clearGroupCards();   // 换图时把人物分组卡片一起清掉，避免显示上一张图的人

  renderBatch();
  updateButtonState();
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
  images.forEach(it => { if (it && it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url); });
  images = [];
  currentIdx = 0;
  currentFile = null;
  batchResults = [];
  batchRunning = false;

  sourceImg.hidden = true;
  sourceImg.removeAttribute('src');
  dropInner.hidden = false;
  dropZone.classList.remove('has-image');
  imgBar.hidden = true;

  resultImg.hidden = true;
  overlay.hidden = true;
  resultPlaceholder.hidden = false;
  resultPlaceholder.innerHTML = '<p>识别结果会显示在这里</p>';

  infoContent.innerHTML = '<p class="info-empty">尚未开始识别。</p>';
  lastResults = null;
  lastGroups = null;
  clearGroupCards();

  renderBatch();
  updateButtonState();
}

