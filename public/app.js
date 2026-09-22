'use strict';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const foldMarks = document.getElementById('fold-marks');
const errorBox = document.getElementById('error-box');
const loading = document.getElementById('loading');
const result = document.getElementById('result');
const sheetsEl = document.getElementById('sheets');
const downloadBtn = document.getElementById('download-btn');

const MAX_SIZE_LABEL = document.getElementById('max-size-label');

let MAX_UPLOAD_MB = 50;
fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    MAX_UPLOAD_MB = Number(cfg.maxUploadMb) || 50;
    MAX_SIZE_LABEL.textContent = MAX_UPLOAD_MB;
  })
  .catch(() => {});

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function clearError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}

function ptToMm(pt) {
  return ((pt * 25.4) / 72).toFixed(1);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function slotHtml(pageNo, originalCount) {
  const blank = pageNo > originalCount;
  return `
    <div class="slot${blank ? ' blank' : ''}">
      <span class="slot-num">${blank ? '空白' : pageNo}</span>
      <span class="slot-cap">${blank ? `补齐第 ${pageNo} 位` : '第 ' + pageNo + ' 页'}</span>
    </div>`;
}

function renderSheets(data) {
  const originalCount = data.meta.originalPageCount;
  sheetsEl.innerHTML = data.sheets
    .map(
      (sheet) => `
      <div class="sheet">
        <div class="sheet-head">
          <span class="sheet-no">第 ${sheet.index} 张纸</span>
          <span class="sheet-hint">对折后为书帖</span>
        </div>
        <div class="face front">
          <div class="face-label"><span>正面</span><span>左 → 右</span></div>
          <div class="face-row">
            ${slotHtml(sheet.front[0], originalCount)}
            ${slotHtml(sheet.front[1], originalCount)}
          </div>
        </div>
        <div class="face back">
          <div class="face-label"><span>背面</span><span>左 → 右</span></div>
          <div class="face-row">
            ${slotHtml(sheet.back[0], originalCount)}
            ${slotHtml(sheet.back[1], originalCount)}
          </div>
        </div>
      </div>`
    )
    .join('');
}

async function impose(file) {
  clearError();
  result.hidden = true;

  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showError('请选择 PDF 文件');
    return;
  }
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    showError(`文件过大（${formatBytes(file.size)}），最大允许 ${MAX_UPLOAD_MB} MB`);
    return;
  }

  loading.hidden = false;

  const form = new FormData();
  form.append('pdf', file);
  form.append('showFoldMarks', String(foldMarks.checked));

  try {
    const resp = await fetch('/api/impose', { method: 'POST', body: form });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      throw new Error((data && data.error) || `拼版失败（HTTP ${resp.status}）`);
    }

    document.getElementById('stat-original').textContent = data.meta.originalPageCount;
    document.getElementById('stat-added').textContent =
      data.meta.addedBlank > 0 ? `+${data.meta.addedBlank}` : '0';
    document.getElementById('stat-sheets').textContent = data.meta.sheetCount;
    document.getElementById('stat-size').textContent =
      `${data.meta.unitWidth}×${data.meta.unitHeight}`;

    document.getElementById('result-meta').textContent =
      `约 ${ptToMm(data.meta.unitWidth * 2)}×${ptToMm(data.meta.unitHeight)} mm/张 · ` +
      `输出 ${formatBytes(data.meta.outputSize)} · 任务保留 ${data.meta.ttlMinutes} 分钟`;

    downloadBtn.href = data.downloadUrl;
    downloadBtn.setAttribute('download', data.downloadName);

    renderSheets(data);
    result.hidden = false;
  } catch (err) {
    showError(err.message || '拼版失败，请重试');
  } finally {
    loading.hidden = true;
  }
}

fileInput.addEventListener('change', () => {
  impose(fileInput.files[0]);
});

// 拖拽上传
['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) {
    fileInput.files = e.dataTransfer.files;
    impose(file);
  }
});
