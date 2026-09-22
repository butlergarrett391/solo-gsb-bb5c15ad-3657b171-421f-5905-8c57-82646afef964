'use strict';

/**
 * 骑马钉（saddle stitch）拼版核心逻辑。
 *
 * 规则：
 *  - 每张纸正反面共承载 4 个原页面；
 *  - 页数不足 4 的倍数时，在文末补空白页；
 *  - 每张纸正面（横向、左右两页）依次为：末页 | 首页；
 *    背面依次为：第二页 | 倒数第二页；
 *  - 其余纸张逐层向内递进（N,1 / 2,N-1 / N-2,3 / 4,N-3 ...）；
 *  - 输出纸张宽度 = 左右两个原页宽度之和，高度取两者最大；
 *    原页面以 100% 比例嵌入，不缩放、不旋转，保持原页面尺寸。
 */

const { PDFDocument, ParseSpeeds, rgb, LineCapStyle } = require('pdf-lib');

const MAX_PAGES = 500;

class ImposeError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ImposeError';
    this.statusCode = statusCode;
  }
}

/**
 * 将 1 起始的总页数补到 4 的倍数，返回每张纸的版面描述。
 *
 * @param {number} originalPageCount
 * @returns {{ paddedPageCount:number, addedBlank:number, sheetCount:number,
 *   sheets:Array<{ front:{left:number,right:number},
 *                  back:{left:number,right:number} }> }}
 *   页码均为 1 起始（含文末补齐的空白页）。
 */
function planBooklet(originalPageCount) {
  if (!Number.isInteger(originalPageCount) || originalPageCount < 1) {
    throw new ImposeError('PDF 至少需要包含 1 页');
  }
  if (originalPageCount > MAX_PAGES) {
    throw new ImposeError(`页数过多（${originalPageCount} 页），最多支持 ${MAX_PAGES} 页`);
  }

  const paddedPageCount = Math.ceil(originalPageCount / 4) * 4;
  const addedBlank = paddedPageCount - originalPageCount;
  const sheetCount = paddedPageCount / 4;

  const sheets = [];
  let lo = 1;
  let hi = paddedPageCount;
  for (let i = 0; i < sheetCount; i += 1) {
    // 正面：末页 | 首页；背面：次页 | 倒数第二页
    sheets.push({
      front: { left: hi--, right: lo++ },
      back: { left: lo++, right: hi-- },
    });
  }

  return { paddedPageCount, addedBlank, sheetCount, sheets };
}

/**
 * 加载并拼版 PDF。
 *
 * @param {Buffer} inputBuffer 原始 PDF 字节
 * @param {object} [options]
 * @param {boolean} [options.showFoldMarks=false] 是否在折叠中线绘制浅灰参考线
 * @returns {Promise<{ pdf:import('pdf-lib').PDFDocument, plan:ReturnType<typeof planBooklet>,
 *   originalPageCount:number, addedBlank:number, unitWidth:number, unitHeight:number,
 *   sheetWidth:number, sheetHeight:number }>}
 */
async function imposePdf(inputBuffer, options = {}) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new ImposeError('上传内容不是有效的文件');
  }

  let src;
  try {
    src = await PDFDocument.load(inputBuffer, { parseSpeed: ParseSpeeds.Fastest });
  } catch (err) {
    const msg = String((err && err.message) || err).toLowerCase();
    if (msg.includes('encrypt') || msg.includes('password')) {
      throw new ImposeError('该 PDF 已加密，请先解除密码后再上传');
    }
    throw new ImposeError('无法解析 PDF 文件，请确认上传的是有效 PDF');
  }

  const originalPageCount = src.getPageCount();
  if (originalPageCount < 1) {
    throw new ImposeError('PDF 不包含任何页面');
  }

  const plan = planBooklet(originalPageCount);
  const { paddedPageCount, sheets } = plan;

  const out = await PDFDocument.create();
  out.setTitle('Booklet Imposition');
  out.setProducer('Booklet Imposer (pdf-lib)');

  // 空白页尺寸以首页为基准
  const unitWidth = src.getPage(0).getWidth();
  const unitHeight = src.getPage(0).getHeight();

  // 将原页以 XObject 形式嵌入输出文档（同一嵌入页可在多张纸上复用）；
  // 文末补齐的空白页在 slots 中记为 null。
  const embedded = await out.embedPdf(src, src.getPageIndices());
  const slots = new Array(paddedPageCount).fill(null);
  for (let i = 0; i < embedded.length; i += 1) slots[i] = embedded[i];

  const dimsOf = (pageNo) => {
    const page = slots[pageNo - 1];
    return page
      ? { w: page.width, h: page.height }
      : { w: unitWidth, h: unitHeight };
  };

  let sheetWidth = 0;
  let sheetHeight = 0;

  for (const sheet of sheets) {
    for (const side of ['front', 'back']) {
      const leftNo = sheet[side].left;
      const rightNo = sheet[side].right;
      const left = slots[leftNo - 1]; // null 即空白页
      const right = slots[rightNo - 1];
      const leftDims = dimsOf(leftNo);
      const rightDims = dimsOf(rightNo);

      // 保持原尺寸：纸宽 = 两页宽之和，纸高 = 较高者；各页垂直居中。
      const width = leftDims.w + rightDims.w;
      const height = Math.max(leftDims.h, rightDims.h);
      sheetWidth = width;
      sheetHeight = height;

      const paper = out.addPage([width, height]);

      if (left) {
        paper.drawPage(left, {
          x: 0,
          y: (height - leftDims.h) / 2,
          width: leftDims.w,
          height: leftDims.h,
        });
      }
      if (right) {
        paper.drawPage(right, {
          x: leftDims.w,
          y: (height - rightDims.h) / 2,
          width: rightDims.w,
          height: rightDims.h,
        });
      }

      if (options.showFoldMarks) {
        paper.drawLine({
          start: { x: width / 2, y: 0 },
          end: { x: width / 2, y: height },
          thickness: 0.5,
          color: rgb(0.8, 0.8, 0.8),
          opacity: 0.6,
          lineCap: LineCapStyle.Butt,
        });
      }
    }
  }

  return {
    pdf: out,
    plan,
    originalPageCount,
    addedBlank: plan.addedBlank,
    unitWidth,
    unitHeight,
    sheetWidth,
    sheetHeight,
  };
}

/** 拼版并直接输出字节。 */
async function buildBooklet(inputBuffer, options) {
  const result = await imposePdf(inputBuffer, options);
  const bytes = await result.pdf.save();
  return { bytes, result };
}

module.exports = {
  planBooklet,
  imposePdf,
  buildBooklet,
  ImposeError,
  MAX_PAGES,
};
