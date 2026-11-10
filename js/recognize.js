/* ============================================================
   recognize.js —— 图片识别流程
   ------------------------------------------------------------
   图片模式的核心：
     · recognizeCurrentImage() —— 对当前这张图跑一遍"检测 → 关键点 → 表情（→ 人脸特征）"
     · runDetect() —— 单张识别（含界面呈现、调试输出）
     · runBatch() —— 批量识别（逐张循环、进度、单张出错不中断整批）
     · exportBatchCsv() —— 批量结果导出表格
   ============================================================ */

/* ============================================================
   图片模式：核心识别流程
   ============================================================ */

/** 当前是否有可识别的图片。
    注意不能只看 currentFile：用「示例图片」或 ?auto= URL 时没有 File 对象，
    currentFile 是 null，但队列里有 url，同样是可以识别的。 */
function hasImage() {
  const it = images[currentIdx];
  return !!(currentFile || (it && it.url));
}

async function runDetect() {
  // 游客体验 1 次的限制（见 auth.js）：已登录或纯静态部署时直接放行
  if (typeof canRunDetection === 'function' && !canRunDetection()) return;
  if (!modelsReady || !hasImage() || busy) return;

  busy = true;
  detectBtn.disabled = true;
  batchBtn.disabled = true;
  const originalText = detectBtn.textContent;
  detectBtn.textContent = '识别中…';

  try {
    const out = await recognizeCurrentImage(true);
    if (out.aborted) return;

    const DEBUG = new URLSearchParams(location.search).has('debug');

    // 结果记进批量统计（单张时也会记，方便对照）
    batchResults[currentIdx] = {
      name: images[currentIdx] ? images[currentIdx].name : '',
      faces: out.results.length,
      top: out.results.length ? topExpression(out.results[0].expressions) : null,
      groups: out.groups ? out.groups.k : null,
      costMs: out.costMs
    };
    renderBatch();

    // 匿名统计上报（单张识别）。只上报计数，图片不会离开浏览器。
    {
      const sum = summarizeResults(out.results);
      reportSession('image', {
        faces: sum.faces, top: sum.top, topVal: sum.topVal,
        costMs: out.costMs, expr: sum.expr
      });
    }

    if (DEBUG) {
      const brief = out.results.map(r => {
        const t = topExpression(r.expressions);
        return `${t.name} ${(t.value * 100).toFixed(1)}%`;
      });
      document.title = `DBG faces=${out.results.length} [${brief.join('|')}] cost=${out.costMs}ms`;
      console.log('[DBG]', document.title);
    } else {
      document.title = `识别完成：${out.results.length}张人脸`;
    }

  } catch (err) {
    console.error('[识别失败]', err);
    showInfo('识别过程出错：' + err.message, true);
  } finally {
    busy = false;
    detectBtn.textContent = originalText;
    batchBtn.disabled = false;
    updateButtonState();
  }
}

/**
 * 对"当前这张图"跑一遍识别，并把结果画到界面上。
 * 抽成独立函数是为了让"单张识别"和"批量识别"共用同一套流程，
 * 避免两份代码各自演化、改了一处忘了另一处。
 * @param {boolean} draw 是否把结果画到右侧画布与信息区
 * @returns {{ results, groups, costMs, aborted? }}
 */
async function recognizeCurrentImage(draw) {
  // 1) 把待识别图片放进右栏
  const item = images[currentIdx] || {};
  const url = item.url || currentFile;
  resultImg.src = url;
  if (resultImg.decode) {
    try { await resultImg.decode(); } catch (e) { /* 个别浏览器不支持，忽略 */ }
  } else {
    await new Promise(res => { resultImg.onload = res; });
  }
  ui.resultShown = true;     // 右侧画布切到"显示图片 + 画布"
  renderView();

  // 2) 关键代码：一次调用完成「检测人脸 → 关键点 → 表情分类」
  //    如果开了"人物分组"，再往链条后面接一步「算 128 维特征」
  const useGroup = groupEnabled;

  // 模型是按需加载的：不勾选分组就不会去下那 6 MB
  if (useGroup && !(await ensureDescriptorNet())) {
    return { results: [], groups: null, costMs: 0, aborted: true };
  }

  const t0 = performance.now();
  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: INPUT_SIZE,
    scoreThreshold: scoreThresholdNow()
  });
  let chain = faceapi
    .detectAllFaces(resultImg, options)   // 检测所有人脸
    .withFaceLandmarks(true)              // 定位 68 个关键点（用轻量模型）
    .withFaceExpressions();               // 逐张人脸做表情分类
  if (useGroup) chain = chain.withFaceDescriptors();   // 计算人脸特征向量（用于分组）
  const results = await chain;
  const costMs = Math.round(performance.now() - t0);
  lastInfoCostMs = costMs;

  // 异常处理 3：一张脸都没检测到
  if (!results || results.length === 0) {
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    lastResults = null;
    lastGroups = null;
    if (draw) {
      showInfo('未检测到人脸。请换一张光线充足、人脸清晰且正面朝向镜头的照片。', true);
      document.title = '未检测到人脸';
    }
    return { results: [], groups: null, costMs: costMs };
  }

  // 3) 如果开了人物分组，先算分组（结果画框和列表都要用）
  let groups = null;
  if (useGroup) {
    const descriptors = results.map(r => Array.from(r.descriptor));
    // 先看所有两两距离里有没有明显断层，有就自动定阈值，没有就用默认值
    const pairDist = [];
    for (let i = 0; i < descriptors.length; i++) {
      for (let j = i + 1; j < descriptors.length; j++) {
        pairDist.push(descriptorDistance(descriptors[i], descriptors[j]));
      }
    }
    const autoTh = autoThreshold(pairDist);
    groups = applyGroups(results, descriptors, autoTh || GROUP_TH);
    groups.autoThreshold = autoTh;
    console.log('[人物分组] 人脸数=' + results.length +
      ' 组数=' + groups.k +
      ' 阈值=' + (autoTh ? autoTh.toFixed(3) + '(自动)' : GROUP_TH + '(默认)') +
      ' 组内最大距离=' + groups.maxIntraDistance.toFixed(3));
  }

  // 4) 画框标注 + 输出结果 + 累计统计
  lastResults = results;
  lastGroups = groups;
  if (draw) {
    drawResults(results, groups);
    renderInfo(results, costMs, groups);
    renderGroupCards(results, groups);   // 下方"人物分组结果"卡片区
  } else {
    // 批量模式不逐张画卡片，但结束时要把最后一张补上（见 runBatch）
  }
  addStats(results);

  return { results, groups, costMs };
}

/**
 * 批量识别：把队列里的每一张都跑一遍，边跑边更新进度。
 * 单张出错不影响其他张 —— 记下错误继续跑，否则一张坏图会毁掉整批。
 */
async function runBatch() {
  if (!modelsReady || !images.length || busy || batchRunning) return;

  batchRunning = true;
  batchResults = [];
  photosData = [];       // 跨照片汇总的数据，每次批量都重算
  galleryData = null;
  batchBtn.disabled = true;

  const total = images.length;
  let failed = 0;
  const t0 = performance.now();

  for (let i = 0; i < total; i++) {
    while (busy) { await new Promise(r => setTimeout(r, 120)); }

    busy = true;
    batchBtn.textContent = '识别中…';
    batchText.textContent = `正在识别：第 ${i + 1} / ${total} 张`;
    batchBar.style.width = (i / total * 100).toFixed(1) + '%';

    try {
      // 切到这一张（会自动清掉上一张的结果与分组）
      showImageAt(i);
      await new Promise(r => setTimeout(r, 60));

      const out = await recognizeCurrentImage(i === total - 1);
      if (out.aborted) break;

      // 把这张图的人脸特征记下来，供"跨照片归属汇总"用
      if (groupEnabled && out.results && out.results.length) {
        photosData.push({
          idx: i,
          name: images[i] ? images[i].name : `第 ${i + 1} 张`,
          url: images[i] ? images[i].url : '',
          faces: out.results.map(r => {
            const top = topExpression(r.expressions);
            return {
              box: r.detection.box,
              descriptor: Array.from(r.descriptor),
              exprName: top.name,
              exprValue: top.value
            };
          })
        });
      }

      batchResults[i] = {
        name: images[i] ? images[i].name : '',
        faces: out.results.length,
        top: out.results.length ? topExpression(out.results[0].expressions) : null,
        groups: out.groups ? out.groups.k : null,
        costMs: out.costMs
      };
      if (!out.results.length) failed++;
    } catch (err) {
      console.warn('[批量识别] 第 ' + (i + 1) + ' 张出错:', err);
      batchResults[i] = { name: images[i] ? images[i].name : '', faces: 0, top: null, groups: null, error: err.message };
      failed++;
    } finally {
      busy = false;
    }

    renderBatch();
    batchBar.style.width = ((i + 1) / total * 100).toFixed(1) + '%';
  }

  // 全部跑完：停回最后一张，让用户看到结果
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  batchRunning = false;
  batchBtn.disabled = false;
  batchBtn.textContent = '批量识别全部';
  const okCount = batchResults.filter(r => r && r.faces > 0).length;
  batchText.textContent = `批量识别完成：${total} 张，共耗时 ${sec} 秒` +
    (failed ? `，其中 ${failed} 张未检出人脸` : '');

  // 匿名统计上报（整批一次）。按每张图的结果汇总成一条记录。
  {
    const sum = { faces: 0, expr: {}, top: null, topVal: null };
    batchResults.forEach(r => {
      if (!r) return;
      sum.faces += r.faces || 0;
      if (r.top) sum.expr[r.top.name] = (sum.expr[r.top.name] || 0) + (r.faces || 1);
      if (r.top && r.top.value > (sum.topVal == null ? -1 : sum.topVal)) { sum.top = r.top.name; sum.topVal = r.top.value; }
    });
    reportSession('batch', {
      faces: sum.faces, top: sum.top, topVal: sum.topVal,
      costMs: Math.round((performance.now() - t0)), expr: sum.expr
    });
  }

  // 跨照片汇总：把所有照片的人脸特征放一起再聚类一次，得到"哪张照片是谁"
  if (groupEnabled && photosData.length) {
    try {
      galleryData = computeCrossPhotoGroups();
      if (galleryData) {
        const personCount = galleryData.groups.filter(g => g.photos.length).length;
        batchText.textContent += `，归到 ${personCount} 个人`;
        console.log('[跨照片汇总] 照片=' + photosData.length +
          ' 人脸=' + galleryData.totalFaces +
          ' 人数=' + personCount +
          ' 阈值=' + galleryData.threshold.toFixed(3));
      }
    } catch (err) {
      console.warn('[跨照片汇总] 计算失败:', err);
      galleryData = null;
    }
  }

  // 记下当前这一张的结果再清空：
  // showImageAt 会把 lastResults/lastGroups 清掉（换图必须清，否则旧框会留在新图上），
  // 但批量结束时要靠这两个变量把最后一张的结果重新画出来，所以先存一份。
  const keepResults = lastResults;
  const keepGroups  = lastGroups;
  const keepCost    = lastInfoCostMs;

  showImageAt(currentIdx);
  // showImageAt 会重置信息区，所以把最后一张的结果重新画一次
  if (keepResults && keepResults.length) {
    lastResults = keepResults;
    lastGroups  = keepGroups;
    lastInfoCostMs = keepCost;
    drawResults(keepResults, keepGroups);
    renderInfo(keepResults, keepCost, keepGroups);
    renderGroupCards(keepResults, keepGroups);
  }

  // 跨照片汇总：照片墙 + 人物归属，并把当前图的框改成跨照片的编号
  if (galleryData) {
    renderGallery();
    redrawCurrentWithCrossPhotoLabels();
    // 有跨照片数据时，人物分组区要显示出来（哪怕当前这张图只有 1 张脸）
    if (galleryData) ui.groupShown = true;
    // 标题统一用跨照片的人数，避免出现"标题 0 个、下面却说 4 个"的矛盾。
    // （必须在 renderGroupCards 之后设置 —— 它会把标题改成当前照片的人数）
    const crossCount = galleryData.groups.filter(g => g.photos.length).length;
    if (groupCount) groupCount.textContent = crossCount;
  } else {
    ui.galleryShown = false;
  }

  updateButtonState();
  renderView();
}

/** 导出批量识别的汇总结果（每张图一行） */
function exportBatchCsv() {
  const done = batchResults.filter(Boolean).length;
  if (!done) { showInfo('还没有可导出的批量结果，先点「批量识别全部」。', true); return; }

  const rows = [['序号', '文件名', '检出人脸数', '主导表情', '置信度(%)', '人物数', '识别耗时(毫秒)', '备注']];
  images.forEach((it, i) => {
    const r = batchResults[i];
    if (!r) return;
    rows.push([
      i + 1,
      r.name,
      r.faces,
      r.faces > 0 && r.top ? (EXPR_CN[r.top.name] || r.top.name) : '',
      r.faces > 0 && r.top ? (r.top.value * 100).toFixed(1) : '',
      r.groups === null || r.groups === undefined ? '' : r.groups,
      r.costMs === undefined ? '' : r.costMs,
      r.error ? ('出错：' + r.error) : (r.faces === 0 ? '未检出人脸' : '')
    ]);
  });

  const csv = '\uFEFF' + rows.map(r => r.map(csvField).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const pad2 = n => String(n).padStart(2, '0');
  a.href = url;
  a.download = `批量识别结果_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
               `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 渲染批量面板：进度、缩略统计、导出按钮。
    面板本身的显隐由 renderView() 按「是否多张」统一决定，这里只管内容。 */
function renderBatch() {
  const total = images.length;
  if (total < 2) {
    batchStats.innerHTML = '';
    return;
  }

  const done = batchResults.filter(Boolean).length;
  if (!batchRunning) {
    if (done === 0) {
      batchText.textContent = `已选择 ${total} 张图片`;
    } else if (done < total) {
      batchText.textContent = `已识别 ${done} / ${total} 张`;
    }
  }

  // 按主导表情汇总
  const byExpr = {};
  let facesTotal = 0;
  batchResults.forEach(r => {
    if (!r || r.error) return;
    facesTotal += r.faces;
    if (r.faces > 0 && r.top) {
      const k = r.top.name;
      byExpr[k] = (byExpr[k] || 0) + 1;
    }
  });

  let html = '';
  if (done > 0) {
    html += `<div>已识别 ${done} 张，累计检出 ${facesTotal} 张人脸</div>`;
    const keys = Object.keys(byExpr).sort((a, b) => byExpr[b] - byExpr[a]);
    if (keys.length) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px">';
      keys.forEach(k => {
        html += `<span class="bs-row"><i class="bs-dot" style="background:${EXPR_COLOR[k]}"></i>` +
                `${EXPR_CN[k]} ${byExpr[k]} 张</span>`;
      });
      html += '</div>';
    }
    const unresolved = images.length - done;
    if (unresolved > 0 && !batchRunning) {
      html += `<div>还有 ${unresolved} 张未识别</div>`;
    }
  }
  batchStats.innerHTML = html;
}

