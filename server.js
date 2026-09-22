'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { imposePdf, ImposeError } = require('./lib/impose');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '50', 10);
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MINUTES || '30', 10) * 60 * 1000;
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '20', 10);

const app = express();
app.disable('x-powered-by');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new ImposeError('仅支持 PDF 文件', 400));
    }
  },
});

/**
 * 内存任务存储：jobId -> { bytes, meta, createdAt }
 * 小型印刷店内网场景下不落盘；定期清理过期任务。
 */
const jobs = new Map();

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}
const sweepTimer = setInterval(sweepJobs, 60 * 1000);
sweepTimer.unref();

function rememberJob(bytes, meta) {
  sweepJobs();
  if (jobs.size >= MAX_JOBS) {
    // 删除最早的任务
    const oldestId = jobs.keys().next().value;
    jobs.delete(oldestId);
  }
  const id = crypto.randomBytes(9).toString('base64url');
  jobs.set(id, { bytes, meta, createdAt: Date.now() });
  return id;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, jobs: jobs.size });
});

// 供前端读取服务端配置（上传上限等）
app.get('/api/config', (_req, res) => {
  res.json({ maxUploadMb: MAX_UPLOAD_MB });
});

/** 上传并拼版，返回每张纸的页码预览与任务信息。 */
app.post('/api/impose', upload.single('pdf'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ImposeError('请选择要上传的 PDF 文件');
    }
    const showFoldMarks = String(req.body.showFoldMarks || '') === 'true';

    const imposed = await imposePdf(req.file.buffer, { showFoldMarks });
    const bytes = await imposed.pdf.save();
    const { plan, originalPageCount, addedBlank, unitWidth, unitHeight } = imposed;

    const downloadName = (path.parse(req.file.originalname).name || 'booklet') + '-拼版.pdf';

    const jobId = rememberJob(bytes, {
      downloadName,
      outputSize: bytes.length,
      originalPageCount,
      paddedPageCount: plan.paddedPageCount,
      addedBlank,
      sheetCount: plan.sheetCount,
    });

    res.json({
      jobId,
      downloadUrl: `/api/download/${jobId}`,
      downloadName,
      meta: {
        originalPageCount,
        paddedPageCount: plan.paddedPageCount,
        addedBlank,
        sheetCount: plan.sheetCount,
        unitWidth: Math.round(unitWidth),
        unitHeight: Math.round(unitHeight),
        outputSize: bytes.length,
        ttlMinutes: Math.round(JOB_TTL_MS / 60000),
      },
      // 页码 1 起始；> originalPageCount 的是文末补齐的空白页
      sheets: plan.sheets.map((sheet, i) => ({
        index: i + 1,
        front: [sheet.front.left, sheet.front.right],
        back: [sheet.back.left, sheet.back.right],
      })),
      blankPageNumbers:
        addedBlank > 0
          ? Array.from({ length: addedBlank }, (_v, i) => originalPageCount + 1 + i)
          : [],
    });
  } catch (err) {
    next(err);
  }
});

/** 下载拼版后的 PDF。 */
app.get('/api/download/:id', (req, res, next) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) {
      throw new ImposeError('任务不存在或已过期，请重新上传拼版', 404);
    }
    const filename = encodeURIComponent(job.meta.downloadName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', job.bytes.length);
    // RFC 5987，兼容中文文件名
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="booklet.pdf"; filename*=UTF-8''${filename}`
    );
    res.end(job.bytes);
  } catch (err) {
    next(err);
  }
});

// 404（API 范围）
app.use('/api', (_req, _res, next) => {
  next(new ImposeError('接口不存在', 404));
});

// 统一错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof ImposeError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res
      .status(413)
      .json({ error: `文件过大，最大允许 ${MAX_UPLOAD_MB} MB（可通过 MAX_UPLOAD_MB 调整）` });
  }
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: '文件上传失败：' + err.message });
  }
  console.error('[impose] 未预期错误：', err);
  return res.status(500).json({ error: '服务器内部错误，请稍后重试' });
});

app.listen(PORT, () => {
  console.log(`[impose] 小册子拼版服务已启动: http://0.0.0.0:${PORT}`);
  console.log(
    `[impose] 上传上限 ${MAX_UPLOAD_MB} MB，任务保留 ${
      JOB_TTL_MS / 60000
    } 分钟，最多缓存 ${MAX_JOBS} 个任务`
  );
});
