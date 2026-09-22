const RevenueFile = require('../models/RevenueFile');
const RevenueData = require('../models/RevenueData');

const BATCH_SIZE = 500;

const MONTH_MAP = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toNum = (v) => {
  if (v === null || v === undefined || v === '' || v === '-') return 0;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
};

const toStr = (v) => (v === null || v === undefined ? '' : String(v).trim());

const parseDayString = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  const match = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const mon = MONTH_MAP[match[2].toLowerCase()];
  const yr = parseInt(match[3], 10);
  const year = yr < 100 ? 2000 + yr : yr;
  if (mon === undefined) return null;
  return new Date(year, mon, day);
};

const sanitizeRecord = (r) => ({
  day: toStr(r.day),
  orderRef: toStr(r.orderRef),
  customerName: toStr(r.customerName),
  productTitle: toStr(r.productTitle),
  price: toNum(r.price),
  netSales: toNum(r.netSales),
  itemNotes: toStr(r.itemNotes),
  itemQty: toNum(r.itemQty) || 1,
  platNo: toStr(r.platNo),
  type: toStr(r.type),
  cost: toNum(r.cost),
  totalCost: toNum(r.totalCost),
  picProject: toStr(r.picProject),
  week: toStr(r.week),
  komisi: toNum(r.komisi),
  totalKomisi: toNum(r.totalKomisi),
  lastPaymentDate: toStr(r.lastPaymentDate),
  category: toStr(r.category),
  area: toStr(r.area),
});

const isEmptyRow = (r) => {
  const hasDay = toStr(r.day).length > 0;
  const hasOrderRef = toStr(r.orderRef).length > 0;
  const hasCustomer = toStr(r.customerName).length > 0;
  const hasAnyValue = toNum(r.netSales) !== 0 || toNum(r.price) !== 0 || toNum(r.totalCost) !== 0;
  return !hasDay && !hasOrderRef && !hasCustomer && !hasAnyValue;
};

const computeMeta = (records) => {
  let totalRevenue = 0, totalCost = 0, totalKomisi = 0;
  records.forEach((r) => {
    totalRevenue += r.netSales || 0;
    totalCost += r.totalCost || r.cost * (r.itemQty || 1) || 0;
    totalKomisi += r.totalKomisi || 0;
  });
  return {
    totalRevenue,
    totalCost,
    totalKomisi,
    totalProfit: totalRevenue - totalCost - totalKomisi,
  };
};

const buildAllYearMonthsInRange = (dateFrom, dateTo) => {
  const parseYM = (ym) => {
    const parts = ym.split('-');
    return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) - 1 };
  };

  let fromYear, fromMonth, toYear, toMonth;

  if (dateFrom) {
    const f = parseYM(dateFrom);
    fromYear = f.year;
    fromMonth = f.month;
  }
  if (dateTo) {
    const t = parseYM(dateTo);
    toYear = t.year;
    toMonth = t.month;
  }
  if (!fromYear) { fromYear = toYear; fromMonth = 0; }
  if (!toYear) { toYear = fromYear; toMonth = 11; }

  const validDayPrefixes = [];
  let y = fromYear, m = fromMonth;
  while (y < toYear || (y === toYear && m <= toMonth)) {
    const shortYear = String(y).slice(-2);
    validDayPrefixes.push(`-${MONTH_ABBR[m]}-${shortYear}`);
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return validDayPrefixes;
};

const buildFilterQuery = (fileId, query) => {
  const q = { fileId };
  const { search, category, area, picProject, dateFrom, dateTo } = query;

  if (search && search.length >= 2) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [
      { customerName: re },
      { platNo: re },
      { productTitle: re },
      { orderRef: re },
      { picProject: re },
    ];
  }

  if (category) q.category = new RegExp(`^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  if (area) q.area = new RegExp(`^${area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  if (picProject) q.picProject = new RegExp(`^${picProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  if (dateFrom || dateTo) {
    const suffixes = buildAllYearMonthsInRange(dateFrom, dateTo);
    if (suffixes.length > 0) {
      const dayRegex = suffixes.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      if (search) {
        q.$or = [...(q.$or || []), { day: { $regex: dayRegex, $options: 'i' } }];
      } else {
        q.day = { $regex: dayRegex, $options: 'i' };
      }
    }
  }

  return q;
};

const uploadRevenue = async (req, res) => {
  const startTime = Date.now();
  try {
    const { fileName, data } = req.body;

    if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
      return res.status(400).json({ success: false, message: 'fileName wajib diisi' });
    }
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ success: false, message: 'Data tidak valid atau kosong' });
    }

    const totalRows = data.length;
    const sanitized = [];
    const failedRows = [];

    data.forEach((r, idx) => {
      if (isEmptyRow(r)) {
        failedRows.push({ index: idx, reason: 'empty_row' });
        return;
      }
      try {
        sanitized.push(sanitizeRecord(r));
      } catch (e) {
        failedRows.push({ index: idx, reason: e.message });
      }
    });

    if (sanitized.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada record valid dalam file', totalRows, failedCount: failedRows.length });
    }

    const meta = computeMeta(sanitized);
    const file = await RevenueFile.create({
      fileName: fileName.trim(),
      recordCount: sanitized.length,
      totalRows,
      failedCount: failedRows.length,
      meta,
    });

    const withFileId = sanitized.map((r) => ({ ...r, fileId: file._id }));
    const totalBatches = Math.ceil(withFileId.length / BATCH_SIZE);
    let insertedCount = 0;
    let insertErrors = 0;

    for (let i = 0; i < withFileId.length; i += BATCH_SIZE) {
      const batch = withFileId.slice(i, i + BATCH_SIZE);
      try {
        const result = await RevenueData.insertMany(batch, { ordered: false });
        insertedCount += result.length;
      } catch (batchErr) {
        if (batchErr.insertedDocs) {
          insertedCount += batchErr.insertedDocs.length;
          insertErrors += batch.length - batchErr.insertedDocs.length;
        } else {
          insertErrors += batch.length;
        }
        console.error(`Batch insert error at offset ${i}:`, batchErr.message);
      }
    }

    await RevenueFile.findByIdAndUpdate(file._id, { recordCount: insertedCount });

    console.log(`Upload complete: totalRows=${totalRows}, sanitized=${sanitized.length}, inserted=${insertedCount}, failed=${failedRows.length + insertErrors}, duration=${Date.now() - startTime}ms`);

    res.status(201).json({
      success: true,
      fileId: file._id,
      fileName: file.fileName,
      recordCount: insertedCount,
      totalRows,
      failedCount: failedRows.length + insertErrors,
      duplicateCount: 0,
      meta,
      duration: `${Date.now() - startTime}ms`,
    });
  } catch (error) {
    console.error('uploadRevenue error:', error.message);
    res.status(500).json({ success: false, message: 'Upload gagal', error: error.message });
  }
};

const getRevenueFiles = async (req, res) => {
  try {
    const files = await RevenueFile.find().sort({ uploadedAt: -1 }).limit(20).lean();
    res.status(200).json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal mengambil daftar file', error: error.message });
  }
};

const getRevenueData = async (req, res) => {
  try {
    const {
      fileId, page = 1, limit = 25,
      search = '', category = '', area = '', picProject = '',
      dateFrom = '', dateTo = '',
    } = req.query;

    if (!fileId) {
      return res.status(400).json({ success: false, message: 'fileId wajib diisi' });
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, Math.min(50000, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const q = buildFilterQuery(fileId, { search, category, area, picProject, dateFrom, dateTo });

    const [data, total] = await Promise.all([
      RevenueData.find(q).sort({ createdAt: 1 }).skip(skip).limit(limitNum).lean(),
      RevenueData.countDocuments(q),
    ]);

    res.status(200).json({
      success: true,
      data,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal mengambil data revenue', error: error.message });
  }
};

const getRevenueSummary = async (req, res) => {
  try {
    const {
      fileId,
      search = '', category = '', area = '', picProject = '',
      dateFrom = '', dateTo = '',
    } = req.query;

    if (!fileId) {
      return res.status(400).json({ success: false, message: 'fileId wajib diisi' });
    }

    const q = buildFilterQuery(fileId, { search, category, area, picProject, dateFrom, dateTo });

    const [aggResult, byCategory, byArea, byProject, byWeek, filters] = await Promise.all([
      RevenueData.aggregate([
        { $match: q },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$netSales' },
            totalCost: { $sum: '$totalCost' },
            totalKomisi: { $sum: '$totalKomisi' },
            count: { $sum: 1 },
          },
        },
      ]),
      RevenueData.aggregate([
        { $match: q },
        { $group: { _id: '$category', revenue: { $sum: '$netSales' }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
      ]),
      RevenueData.aggregate([
        { $match: q },
        { $group: { _id: '$area', revenue: { $sum: '$netSales' }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
      ]),
      RevenueData.aggregate([
        { $match: q },
        { $group: { _id: '$picProject', revenue: { $sum: '$netSales' }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
      ]),
      RevenueData.aggregate([
        { $match: q },
        {
          $group: {
            _id: { $cond: [{ $ne: ['$week', ''] }, '$week', { $substr: ['$day', 0, 7] }] },
            revenue: { $sum: '$netSales' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      RevenueData.aggregate([
        { $match: { fileId: q.fileId } },
        {
          $group: {
            _id: null,
            categories: { $addToSet: '$category' },
            areas: { $addToSet: '$area' },
            projects: { $addToSet: '$picProject' },
          },
        },
      ]),
    ]);

    const agg = aggResult[0] || { totalRevenue: 0, totalCost: 0, totalKomisi: 0, count: 0 };
    const totalProfit = agg.totalRevenue - agg.totalCost - agg.totalKomisi;

    const clean = (arr) =>
      arr
        .map((d) => ({ label: d._id || '(kosong)', value: d.revenue, count: d.count }))
        .filter((d) => d.label !== '(kosong)' || d.value !== 0);

    const filterMeta = filters[0] || { categories: [], areas: [], projects: [] };

    res.status(200).json({
      success: true,
      summary: {
        totalRevenue: agg.totalRevenue,
        totalCost: agg.totalCost,
        totalKomisi: agg.totalKomisi,
        totalProfit,
        count: agg.count,
      },
      byCategory: clean(byCategory),
      byArea: clean(byArea),
      byProject: clean(byProject),
      byWeek: byWeek.map((d) => ({ label: d._id || 'N/A', value: d.revenue, count: d.count })),
      filters: {
        categories: filterMeta.categories.filter(Boolean).sort(),
        areas: filterMeta.areas.filter(Boolean).sort(),
        projects: filterMeta.projects.filter(Boolean).sort(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal mengambil summary revenue', error: error.message });
  }
};

const deleteRevenueFile = async (req, res) => {
  try {
    const { id } = req.params;
    const file = await RevenueFile.findByIdAndDelete(id).lean();
    if (!file) {
      return res.status(404).json({ success: false, message: 'File tidak ditemukan' });
    }
    const { deletedCount } = await RevenueData.deleteMany({ fileId: id });
    res.status(200).json({ success: true, message: 'File dan data berhasil dihapus', deletedRecords: deletedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal menghapus file', error: error.message });
  }
};

const updateRevenueRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const sanitized = sanitizeRecord(req.body);
    const updated = await RevenueData.findByIdAndUpdate(id, sanitized, { new: true, runValidators: true }).lean();
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Record tidak ditemukan' });
    }
    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal memperbarui record', error: error.message });
  }
};

const deleteRevenueRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await RevenueData.findByIdAndDelete(id).lean();
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Record tidak ditemukan' });
    }
    res.status(200).json({ success: true, data: deleted });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal menghapus record', error: error.message });
  }
};

module.exports = {
  uploadRevenue,
  getRevenueFiles,
  getRevenueData,
  getRevenueSummary,
  deleteRevenueFile,
  updateRevenueRecord,
  deleteRevenueRecord,
};