const FleetData = require('../models/FleetData');
const XLSX = require('xlsx');

const BATCH_SIZE = 1000;

const findDuplicates = async (dataArray) => {
  const seen = new Set();
  const duplicatesInPayload = [];

  dataArray.forEach((item, index) => {
    const key = (item.vehNumb || '').toUpperCase().trim();
    if (!key) return;
    if (seen.has(key)) {
      duplicatesInPayload.push({ row: index + 2, data: item, duplicateFields: ['vehNumb'] });
    } else {
      seen.add(key);
    }
  });

  const vehNumbs = [...seen];
  const existingFleet = await FleetData.find({ vehNumb: { $in: vehNumbs } }).lean();
  const existingSet = new Set(existingFleet.map((d) => (d.vehNumb || '').toUpperCase().trim()));

  const duplicatesInDB = dataArray
    .map((item, index) => {
      const key = (item.vehNumb || '').toUpperCase().trim();
      if (key && existingSet.has(key)) return { row: index + 2, data: item, duplicateFields: ['vehNumb'] };
      return null;
    })
    .filter(Boolean);

  return {
    duplicatesInPayload,
    duplicatesInDB,
    hasDuplicates: duplicatesInPayload.length > 0 || duplicatesInDB.length > 0,
  };
};

const safeString = (val) => {
  if (val === null || val === undefined) return '';
  return String(val).trim();
};

const transformFleetItem = (item) => ({
  vehNumb:         safeString(item.vehNumb).toUpperCase(),
  unitBrand:       safeString(item.unitBrand),
  type:            safeString(item.type),
  unitColour:      safeString(item.unitColour),
  category:        safeString(item.category),
  name:            safeString(item.name),
  project:         safeString(item.project),
  pic:             safeString(item.pic),
  distribusi:      safeString(item.distribusi),
  releaseDate:     safeString(item.releaseDate),
  returnDate:      safeString(item.returnDate),
  hoDate:          safeString(item.hoDate),
  molis:           safeString(item.molis),
  deductionAmount: safeString(item.deductionAmount),
  notes:           safeString(item.notes),
  status:          safeString(item.status),
  phoneNumber:     safeString(item.phoneNumber),
  rushHour:        safeString(item.rushHour),
  statusSecond:    safeString(item.statusSecond),
});

const transformFleetData = (dataArray) => {
  const validRows = [];
  const skippedRows = [];

  dataArray.forEach((item, index) => {
    const vehNumb = safeString(item.vehNumb);
    if (!vehNumb) {
      skippedRows.push(index + 1);
      return;
    }
    validRows.push(transformFleetItem(item));
  });

  return { validRows, skippedRows };
};

const handleBatchUpsert = async (batch, batchNum, totalBatches) => {
  console.log(`Processing fleet batch ${batchNum}/${totalBatches} (${batch.length} records)`);
  try {
    const bulkOps = batch.map((item) => ({
      updateOne: {
        filter: { vehNumb: item.vehNumb },
        update: { $set: { ...item, updatedAt: Date.now() } },
        upsert: true,
      },
    }));
    const result = await FleetData.bulkWrite(bulkOps, { ordered: false });
    const insertedCount = result.upsertedCount || 0;
    const updatedCount = result.modifiedCount || 0;
    return { batchNum, inserted: insertedCount, updated: updatedCount, processed: insertedCount + updatedCount, records: batch.length, success: true };
  } catch (error) {
    throw new Error(`Database operation failed at batch ${batchNum}: ${error.message}`);
  }
};

const processBatchUpserts = async (validRows) => {
  let totalProcessed = 0, totalInserted = 0, totalUpdated = 0;
  const batchResults = [];
  const totalBatches = Math.ceil(validRows.length / BATCH_SIZE);

  for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
    const batch = validRows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const result = await handleBatchUpsert(batch, batchNum, totalBatches);
    totalProcessed += result.processed;
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    batchResults.push(result);
  }

  return { totalProcessed, totalInserted, totalUpdated, batchResults };
};

const uploadFleetData = async (req, res) => {
  const startTime = Date.now();
  try {
    const dataArray = req.body;
    const replaceAll = req.headers['x-replace-data'] === 'true';

    if (!Array.isArray(dataArray) || dataArray.length === 0) {
      return res.status(400).json({
        message: 'Data fleet tidak valid atau kosong',
        error: 'Request body harus berupa array yang tidak kosong',
        success: false,
      });
    }

    const { validRows, skippedRows } = transformFleetData(dataArray);

    if (validRows.length === 0) {
      return res.status(400).json({
        message: 'Tidak ada data valid untuk diproses',
        error: 'Semua baris tidak memiliki nilai License Plate. Pastikan kolom "License Plate" terisi.',
        skippedCount: skippedRows.length,
        success: false,
      });
    }

    if (!replaceAll) {
      const validationResult = await findDuplicates(validRows);
      if (validationResult.hasDuplicates) {
        const totalDuplicates = validationResult.duplicatesInPayload.length + validationResult.duplicatesInDB.length;
        return res.status(409).json({
          message: `Ditemukan ${totalDuplicates} License Plate duplikat yang perlu diperbaiki sebelum upload`,
          success: false,
          duplicates: {
            inPayload: validationResult.duplicatesInPayload,
            inDatabase: validationResult.duplicatesInDB,
            total: totalDuplicates,
          },
          details: {
            totalRecords: validRows.length,
            duplicatesInFile: validationResult.duplicatesInPayload.length,
            duplicatesInDatabase: validationResult.duplicatesInDB.length,
            skippedRows: skippedRows.length,
          },
        });
      }
    }

    const { totalProcessed, totalInserted, totalUpdated, batchResults } = await processBatchUpserts(validRows);
    const duration = Date.now() - startTime;
    const currentCount = await FleetData.countDocuments();

    res.status(201).json({
      message: 'Data fleet berhasil disimpan ke database',
      count: totalProcessed,
      summary: {
        totalRecords: totalProcessed,
        insertedRecords: totalInserted,
        updatedRecords: totalUpdated,
        processedRecords: validRows.length,
        skippedRecords: skippedRows.length,
        databaseTotal: currentCount,
        success: true,
        duration: `${duration}ms`,
        batchResults,
      },
      success: true,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    res.status(500).json({ message: 'Upload data fleet gagal', error: error.message, duration: `${duration}ms`, success: false });
  }
};

const buildSearchQuery = (searchTerm) => {
  if (!searchTerm || searchTerm.length < 2) return {};
  const searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return {
    $or: [
      { vehNumb: searchRegex },
      { name: searchRegex },
      { unitBrand: searchRegex },
      { type: searchRegex },
      { category: searchRegex },
      { project: searchRegex },
      { pic: searchRegex },
      { distribusi: searchRegex },
      { status: searchRegex },
      { notes: searchRegex },
    ],
  };
};

const buildFilterQuery = (filters) => {
  const query = {};
  const safeRegex = (val) => new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (filters.status) query.status = safeRegex(filters.status);
  if (filters.project) query.project = safeRegex(filters.project);
  if (filters.type) query.type = safeRegex(filters.type);
  if (filters.category) query.category = safeRegex(filters.category);
  if (filters.distribusi) query.distribusi = safeRegex(filters.distribusi);
  return query;
};

const buildSortQuery = (sortKey, sortDirection) => {
  const allowedKeys = ['createdAt', 'name', 'vehNumb', 'status', 'project', 'type', 'category', 'distribusi', 'unitBrand', 'updatedAt'];
  const key = allowedKeys.includes(sortKey) ? sortKey : 'createdAt';
  return { [key]: sortDirection === 'asc' ? 1 : -1 };
};

const getAllFleetData = async (req, res) => {
  try {
    const {
      page = 1, limit = 25, search = '',
      sortKey = 'createdAt', sortDirection = 'desc',
      status = '', project = '', type = '', category = '', distribusi = '',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const combinedQuery = { ...buildSearchQuery(search), ...buildFilterQuery({ status, project, type, category, distribusi }) };
    const sortQuery = buildSortQuery(sortKey, sortDirection);

    const [data, total] = await Promise.all([
      FleetData.find(combinedQuery).sort(sortQuery).skip(skip).limit(limitNum).lean().exec(),
      FleetData.countDocuments(combinedQuery),
    ]);

    res.status(200).json({
      message: 'Data fleet berhasil diambil',
      count: data.length,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      hasMore: pageNum * limitNum < total,
      data,
    });
  } catch (error) {
    res.status(500).json({ message: 'Gagal mengambil data fleet', error: error.message });
  }
};

const exportFleetData = async (req, res) => {
  try {
    const {
      search = '', sortKey = 'createdAt', sortDirection = 'desc',
      status = '', project = '', type = '', category = '', distribusi = '',
    } = req.body;

    const combinedQuery = { ...buildSearchQuery(search), ...buildFilterQuery({ status, project, type, category, distribusi }) };
    const data = await FleetData.find(combinedQuery).sort(buildSortQuery(sortKey, sortDirection)).lean();

    const exportData = data.map((item) => ({
      'License Plate': item.vehNumb,
      'Vehicle Brand': item.unitBrand,
      'Vehicle Model': item.type,
      'Vehicle Color': item.unitColour,
      'Fleet Category': item.category,
      'Assigned Driver': item.name,
      'Project': item.project,
      'Person in Charge': item.pic,
      'Deployment Area': item.distribusi,
      'Dispatch Date': item.releaseDate,
      'Return Date': item.returnDate,
      'Handover Date': item.hoDate,
      'Usage Cycle': item.molis,
      'Remaining Service Life': item.deductionAmount,
      'Unit Remarks': item.notes,
      'Asset Status': item.status,
      'Created At': new Date(item.createdAt).toLocaleString('id-ID'),
      'Updated At': new Date(item.updatedAt).toLocaleString('id-ID'),
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Fleet Data');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Fleet_Data_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ message: 'Gagal export data fleet', error: error.message });
  }
};

const updateFleetData = async (req, res) => {
  try {
    const { id } = req.params;
    const vehNumb = safeString(req.body.vehNumb);

    if (!vehNumb) {
      return res.status(400).json({
        message: 'Field wajib tidak boleh kosong: License Plate (vehNumb)',
        error: 'vehNumb harus diisi untuk memperbarui data fleet',
        success: false,
      });
    }

    const transformedData = transformFleetItem(req.body);
    const updatedFleet = await FleetData.findByIdAndUpdate(
      id,
      { ...transformedData, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).lean();

    if (!updatedFleet) {
      return res.status(404).json({ message: 'Data fleet tidak ditemukan', error: 'Fleet dengan ID tersebut tidak ada' });
    }

    res.status(200).json({ message: 'Data fleet berhasil diperbarui', data: updatedFleet });
  } catch (error) {
    res.status(500).json({ message: 'Gagal memperbarui data fleet', error: error.message });
  }
};

const deleteFleetData = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedFleet = await FleetData.findByIdAndDelete(id).lean();
    if (!deletedFleet) {
      return res.status(404).json({ message: 'Data fleet tidak ditemukan', error: 'Fleet dengan ID tersebut tidak ada' });
    }
    res.status(200).json({ message: 'Data fleet berhasil dihapus', data: deletedFleet });
  } catch (error) {
    res.status(500).json({ message: 'Gagal menghapus data fleet', error: error.message });
  }
};

const deleteMultipleFleetData = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Invalid request: No IDs provided', error: 'Array of IDs is required' });
    }
    const result = await FleetData.deleteMany({ _id: { $in: ids } });
    res.status(200).json({
      message: `${result.deletedCount} data fleet berhasil dihapus`,
      deletedCount: result.deletedCount,
      requestedCount: ids.length,
    });
  } catch (error) {
    res.status(500).json({ message: 'Gagal menghapus data fleet', error: error.message });
  }
};

const deleteAllFleetData = async (req, res) => {
  try {
    const result = await FleetData.deleteMany({});
    res.status(200).json({ message: 'Semua data fleet berhasil dihapus', deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: 'Gagal menghapus data fleet', error: error.message });
  }
};

const getFleetFilters = async (req, res) => {
  try {
    const [statuses, projects, types, categories, distribusiList] = await Promise.all([
      FleetData.distinct('status', { status: { $ne: '', $exists: true } }),
      FleetData.distinct('project', { project: { $ne: '', $exists: true } }),
      FleetData.distinct('type', { type: { $ne: '', $exists: true } }),
      FleetData.distinct('category', { category: { $ne: '', $exists: true } }),
      FleetData.distinct('distribusi', { distribusi: { $ne: '', $exists: true } }),
    ]);

    const [activeCount, totalCount] = await Promise.all([
      FleetData.countDocuments({ status: { $regex: /active/i } }),
      FleetData.countDocuments(),
    ]);

    res.status(200).json({
      statuses: statuses.filter(Boolean).sort(),
      projects: projects.filter(Boolean).sort(),
      types: types.filter(Boolean).sort(),
      categories: categories.filter(Boolean).sort(),
      distribusiList: distribusiList.filter(Boolean).sort(),
      statistics: { total: totalCount, active: activeCount, inactive: totalCount - activeCount },
    });
  } catch (error) {
    res.status(500).json({ message: 'Gagal mengambil filter fleet', error: error.message });
  }
};

const getFleetDataByPlat = async (req, res) => {
  try {
    const vehNumb = req.params.plat;
    const data = await FleetData.find({ vehNumb: { $regex: new RegExp(vehNumb, 'i') } }).lean();
    if (!data || data.length === 0) {
      return res.status(404).json({ message: `Data fleet untuk nomor kendaraan ${vehNumb} tidak ditemukan`, count: 0, data: [] });
    }
    res.status(200).json({ message: `Data fleet untuk nomor kendaraan ${vehNumb} berhasil diambil`, count: data.length, data });
  } catch (error) {
    res.status(500).json({ message: 'Gagal mengambil data fleet berdasarkan nomor kendaraan', error: error.message });
  }
};

const getFleetInfo = async (req, res) => {
  try {
    const fleetCount = await FleetData.countDocuments();
    res.status(200).json({ fleetCount, message: 'Fleet info retrieved successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Gagal mengambil info fleet', error: error.message });
  }
};

module.exports = {
  uploadFleetData,
  getAllFleetData,
  exportFleetData,
  getFleetFilters,
  getFleetDataByPlat,
  deleteFleetData,
  deleteAllFleetData,
  deleteMultipleFleetData,
  updateFleetData,
  getFleetInfo,
};