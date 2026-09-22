const mongoose = require('mongoose');
const axios = require('axios');

const API_BASE = process.env.INTERNAL_API_URL || 'http://localhost:5000';

const merchantOrderSchema = new mongoose.Schema({
  merchant_order_id: { type: String, required: true, trim: true },
  weight: { type: Number, required: true, default: 0 },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  length: { type: Number, default: 0 },
  payment_type: { type: String, required: true, enum: ['cod', 'non_cod'], default: 'non_cod' },
  cod_amount: { type: Number, default: 0 },
  sender_name: { type: String, required: true, trim: true },
  sender_phone: { type: String, required: true, trim: true },
  pickup_instructions: { type: String, trim: true, default: '' },
  consignee_name: { type: String, required: true, trim: true },
  consignee_phone: { type: String, required: true, trim: true },
  destination_district: { type: String, trim: true, default: '' },
  destination_city: { type: String, required: true, trim: true },
  destination_province: { type: String, trim: true, default: '' },
  destination_postalcode: { type: String, trim: true, default: '' },
  destination_address: { type: String, required: true, trim: true },
  destination_address_override: { type: String, trim: true, default: null },
  dropoff_lat: { type: Number, default: 0 },
  dropoff_long: { type: Number, default: 0 },
  dropoff_instructions: { type: String, trim: true, default: '' },
  item_value: { type: Number, default: 0 },
  product_details: { type: String, trim: true, default: '' },
  riders: { type: String, trim: true, default: null },
  is_completed: { type: Boolean, default: false },
  completed_blitz_status: { type: String, trim: true, default: null },
  completed_batch_status: { type: String, trim: true, default: null },
  completed_batch_id: { type: Number, default: null },
  completed_driver_name: { type: String, trim: true, default: null },
  completed_driver_contact: { type: String, trim: true, default: null },
  completed_awb_number: { type: String, trim: true, default: null },
  photo_data: {
    image: { type: String, default: null },
    timestamp: { type: Date, default: null },
    address: { type: String, default: null },
  },
}, { timestamps: true });

merchantOrderSchema.index({ merchant_order_id: 1 });
merchantOrderSchema.index({ destination_city: 1 });
merchantOrderSchema.index({ payment_type: 1 });
merchantOrderSchema.index({ sender_name: 1 });
merchantOrderSchema.index({ is_completed: 1 });
merchantOrderSchema.index({ is_completed: 1, sender_name: 1 });

const adminPanelValidationSchema = new mongoose.Schema({
  sender_name: { type: String, required: true, unique: true, trim: true },
  business: { type: Number, required: true },
  city: { type: Number, required: true },
  service_type: { type: Number, required: true },
  business_hub: { type: Number, required: true },
  location: {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true }
  },
  spreadsheets: { type: mongoose.Schema.Types.Mixed, default: null },
  worksheet: { type: String, trim: true, default: null },
  project_name: { type: String, trim: true, default: null },
}, { timestamps: true });

adminPanelValidationSchema.index({ location: '2dsphere' });
adminPanelValidationSchema.index({ sender_name: 1 });

const getModel = (project) => {
  const collectionName = `${project}_merchant_orders`;
  if (mongoose.models[collectionName]) {
    delete mongoose.models[collectionName];
  }
  return mongoose.model(collectionName, merchantOrderSchema, collectionName);
};

const getAdminPanelValidationModel = () => {
  const collectionName = 'adminpanel_validations';
  if (mongoose.models[collectionName]) return mongoose.models[collectionName];
  return mongoose.model(collectionName, adminPanelValidationSchema, collectionName);
};

const validateBlitzRequiredFields = (order) => {
  const errors = [];
  if (!order.merchant_order_id?.trim()) errors.push('merchant_order_id missing');
  if (!order.weight || order.weight <= 0) errors.push('weight must be greater than 0');
  if (!order.sender_name?.trim()) errors.push('sender_name missing');
  if (!order.sender_phone?.trim()) errors.push('sender_phone missing');
  if (!order.consignee_name?.trim()) errors.push('consignee_name missing');
  if (!order.consignee_phone?.trim()) errors.push('consignee_phone missing');
  if (!order.destination_city?.trim()) errors.push('destination_city missing');
  if (!order.destination_postalcode?.trim()) errors.push('destination_postalcode missing');
  if (!order.destination_address?.trim()) errors.push('destination_address missing');
  if (order.payment_type !== 'cod' && order.payment_type !== 'non_cod') errors.push('payment_type must be cod or non_cod');
  return errors;
};

const getDriverProjects = async (project, driverId) => {
  try {
    const collectionName = `${project}_delivery`;
    const collection = mongoose.connection.db.collection(collectionName);
    const driverData = await collection.findOne({ driver_id: driverId.toString() });
    if (!driverData || !Array.isArray(driverData.projects) || driverData.projects.length === 0) return null;
    return driverData.projects;
  } catch {
    return null;
  }
};

const getAccountBySenderNames = async (project, senderNames) => {
  try {
    const collectionName = `${project}_delivery`;
    const collection = mongoose.connection.db.collection(collectionName);
    const accounts = await collection.find({ projects: { $in: senderNames } }).toArray();
    const map = {};
    for (const acc of accounts) {
      if (Array.isArray(acc.projects)) {
        for (const proj of acc.projects) {
          if (senderNames.includes(proj)) map[proj] = acc;
        }
      }
    }
    return map;
  } catch {
    return {};
  }
};

const TRULY_COMPLETED_BLITZ_STATUSES = ['dropoff_done', 'delivered', 'completed', 'return_failed'];

const isBlitzStatusTrulyCompleted = (status) =>
  TRULY_COMPLETED_BLITZ_STATUSES.includes((status || '').toLowerCase().trim());

const UPDATABLE_FIELDS = [
  'weight', 'width', 'height', 'length',
  'payment_type', 'cod_amount',
  'sender_name', 'sender_phone', 'pickup_instructions',
  'consignee_name', 'consignee_phone',
  'destination_district', 'destination_city', 'destination_province',
  'destination_postalcode', 'destination_address',
  'dropoff_lat', 'dropoff_long', 'dropoff_instructions',
  'item_value', 'product_details', 'riders',
  'is_completed', 'completed_blitz_status', 'completed_batch_status',
  'completed_batch_id', 'completed_driver_name', 'completed_driver_contact',
  'completed_awb_number',
];

const normalizeValidationData = (validationData) => {
  if (!validationData) return null;
  if (
    validationData.location &&
    validationData.location.coordinates &&
    Array.isArray(validationData.location.coordinates) &&
    validationData.location.coordinates.length === 2
  ) {
    return validationData;
  }
  if (
    validationData.data &&
    validationData.data.location &&
    validationData.data.location.coordinates
  ) {
    return validationData.data;
  }
  return null;
};

const extractSpreadsheetId = (url) => {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
};

const extractGidFromUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/[?&#]gid=(\d+)/);
  return match ? match[1] : null;
};

const DEFAULT_WORKSHEET = 'DATA_ORDER';

const resolveWorksheetName = (entry) => {
  const ws = entry.worksheet;
  if (ws && typeof ws === 'string' && ws.trim() !== '') return ws.trim();
  return DEFAULT_WORKSHEET;
};

const hasValidSpreadsheetConfig = (entry) => {
  const spreadsheets = entry.spreadsheets;
  if (!spreadsheets) return false;
  if (typeof spreadsheets === 'string') {
    const trimmed = spreadsheets.trim();
    return trimmed !== '' && extractSpreadsheetId(trimmed) !== null;
  }
  if (typeof spreadsheets === 'object' && !Array.isArray(spreadsheets)) {
    if (spreadsheets.enabled === false) return false;
    const rawUrl = spreadsheets.url || '';
    const spreadsheetId = spreadsheets.spreadsheet_id || spreadsheets.id || extractSpreadsheetId(rawUrl);
    return !!spreadsheetId;
  }
  return false;
};

const resolveSpreadsheetConfig = (entry) => {
  const spreadsheets = entry.spreadsheets;
  if (!spreadsheets) return null;
  const worksheetName = resolveWorksheetName(entry);
  if (typeof spreadsheets === 'string' && spreadsheets.trim() !== '') {
    const rawUrl = spreadsheets.trim();
    const spreadsheetId = extractSpreadsheetId(rawUrl);
    if (!spreadsheetId) return null;
    const gid = extractGidFromUrl(rawUrl);
    return { spreadsheetId, worksheetName, gid, originalUrl: rawUrl, enabled: true };
  }
  if (typeof spreadsheets === 'object' && !Array.isArray(spreadsheets)) {
    const enabled = spreadsheets.enabled !== false;
    if (!enabled) return null;
    const rawUrl = spreadsheets.url || '';
    const spreadsheetId = spreadsheets.spreadsheet_id || spreadsheets.id || extractSpreadsheetId(rawUrl);
    if (!spreadsheetId) return null;
    const gid = extractGidFromUrl(rawUrl);
    return { spreadsheetId, worksheetName, gid, originalUrl: rawUrl, enabled: true };
  }
  return null;
};

const parseCsvToRows = (csvText) => {
  const lines = csvText.split('\n');
  return lines.map(line => {
    const row = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    row.push(current.trim());
    return row;
  }).filter(row => row.some(cell => cell !== ''));
};

const fetchSpreadsheetViaCsvExport = async (spreadsheetId, gid) => {
  let exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
  if (gid) exportUrl += `&gid=${gid}`;

  const response = await axios.get(exportUrl, {
    timeout: 30000,
    responseType: 'text',
    headers: { 'Accept': 'text/csv,text/plain,*/*', 'User-Agent': 'Mozilla/5.0' },
    maxRedirects: 10,
    validateStatus: (status) => status < 500,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('Spreadsheet tidak dapat diakses. Pastikan spreadsheet dibagikan sebagai "Anyone with the link can view".');
  }

  if (!response.data || typeof response.data !== 'string') {
    throw new Error(`CSV export mengembalikan response kosong (HTTP ${response.status})`);
  }

  const trimmed = response.data.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
    throw new Error('Spreadsheet tidak dapat diakses publik. Bagikan spreadsheet sebagai "Anyone with the link can view".');
  }

  const rows = parseCsvToRows(response.data);
  if (!rows || rows.length < 2) {
    throw new Error(`CSV berhasil diambil tetapi hanya memiliki ${rows ? rows.length : 0} baris`);
  }

  return rows;
};

const fetchSpreadsheetViaApi = async (spreadsheetId, sheetName, googleApiKey) => {
  if (!googleApiKey) return { data: null, error: 'GOOGLE_SHEETS_API_KEY tidak dikonfigurasi' };
  try {
    const encodedSheet = encodeURIComponent(sheetName);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedSheet}?key=${googleApiKey}`;
    const response = await axios.get(url, { timeout: 30000 });
    if (!response.data || !response.data.values || response.data.values.length < 2) {
      return { data: null, error: `Sheets API mengembalikan ${response.data && response.data.values ? response.data.values.length : 0} baris` };
    }
    return { data: response.data.values, error: null };
  } catch (err) {
    const msg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message;
    return { data: null, error: `Sheets API error: ${msg}` };
  }
};

const fetchSpreadsheetData = async (spreadsheetId, sheetName, googleApiKey, gid) => {
  if (googleApiKey) {
    const apiResult = await fetchSpreadsheetViaApi(spreadsheetId, sheetName, googleApiKey);
    if (apiResult.data) return { data: apiResult.data, error: null };
  }

  try {
    const csvData = await fetchSpreadsheetViaCsvExport(spreadsheetId, gid);
    return { data: csvData, error: null };
  } catch (csvErr) {
    const apiError = googleApiKey ? `API gagal, ` : '';
    return { data: null, error: `${apiError}CSV export gagal: ${csvErr.message}` };
  }
};

const parseRiders = (value) => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  const emptyValues = ['', '0', 'null', 'undefined'];
  return emptyValues.includes(str) ? null : str;
};

const normalizeHeader = (header) =>
  header.toString().toLowerCase().replace(/\*/g, '').trim();

const transformSheetRowToOrder = (headers, row) => {
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
  return {
    merchant_order_id: String(obj.merchant_order_id || '').trim(),
    weight: parseFloat(obj.weight) || 0,
    width: parseFloat(obj.width) || 0,
    height: parseFloat(obj.height) || 0,
    length: parseFloat(obj.length) || 0,
    payment_type: String(obj.payment_type || 'non_cod'),
    cod_amount: parseFloat(obj.cod_amount) || 0,
    sender_name: String(obj.sender_name || ''),
    sender_phone: String(obj.sender_phone || ''),
    pickup_instructions: String(obj.pickup_instructions || ''),
    consignee_name: String(obj.consignee_name || ''),
    consignee_phone: String(obj.consignee_phone || ''),
    destination_district: String(obj.destination_district || ''),
    destination_city: String(obj.destination_city || ''),
    destination_province: String(obj.destination_province || ''),
    destination_postalcode: String(obj.destination_postalcode || ''),
    destination_address: String(obj.destination_address || ''),
    dropoff_lat: parseFloat(obj.dropoff_lat) || 0,
    dropoff_long: parseFloat(obj.dropoff_long) || 0,
    dropoff_instructions: String(obj.dropoff_instructions || ''),
    item_value: parseFloat(obj.item_value) || 0,
    product_details: String(obj.product_details || ''),
    riders: parseRiders(obj.riders),
  };
};

const isRowEmpty = (row) =>
  !row.some(cell => cell !== '' && cell !== null && cell !== undefined);

const isRowAllRef = (row) =>
  row.every(cell => String(cell).trim() === '#REF!');

exports.updatePhotoAndAddress = async (req, res) => {
  try {
    const { project, merchantOrderId } = req.params;
    const { photo, timestamp, address, destination_address_override, action } = req.body;

    if (!merchantOrderId) {
      return res.status(400).json({ success: false, message: 'merchantOrderId is required' });
    }

    const Model = getModel(project);
    const existing = await Model.findOne({ merchant_order_id: merchantOrderId });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const updateFields = {};

    if (action === 'revert_to_original') {
      updateFields.destination_address_override = null;
      updateFields['photo_data.image'] = null;
      updateFields['photo_data.timestamp'] = null;
      updateFields['photo_data.address'] = null;
    } else if (action === 'revert_to_previous') {
      const previousOverride = existing.destination_address_override;
      if (previousOverride) {
        updateFields.destination_address_override = previousOverride;
      } else {
        updateFields.destination_address_override = null;
      }
    } else {
      if (destination_address_override !== undefined) {
        updateFields.destination_address_override = destination_address_override || null;
      }

      if (photo) {
        updateFields['photo_data.image'] = photo;
        updateFields['photo_data.timestamp'] = timestamp ? new Date(timestamp) : new Date();
        updateFields['photo_data.address'] = address || null;
      }

      if (address !== undefined && !photo) {
        updateFields['photo_data.address'] = address || null;
      }
    }

    if (Object.keys(updateFields).length === 0) {
      return res.json({ success: true, message: 'No fields to update', data: existing });
    }

    const updated = await Model.findOneAndUpdate(
      { merchant_order_id: merchantOrderId },
      { $set: updateFields },
      { new: true, runValidators: false }
    );

    res.json({ success: true, message: 'Photo and address updated successfully', data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update photo and address', error: error.message });
  }
};

exports.syncFromSpreadsheet = async (req, res) => {
  try {
    const { project } = req.params;
    const { driver_id } = req.mitra;
    const { enabledSenders } = req.body;

    const driverProjects = await getDriverProjects(project, driver_id);
    if (!driverProjects || driverProjects.length === 0) {
      return res.json({ success: true, synced: false, message: 'Tidak ada project yang ditemukan untuk driver', uploaded: 0 });
    }

    const targetSenders = Array.isArray(enabledSenders) && enabledSenders.length > 0
      ? driverProjects.filter(p => enabledSenders.includes(p))
      : driverProjects;

    if (targetSenders.length === 0) {
      return res.json({ success: true, synced: false, message: 'Tidak ada sender yang diaktifkan untuk disinkronkan', uploaded: 0 });
    }

    const ValidationModel = getAdminPanelValidationModel();
    const validationEntries = await ValidationModel.find({
      sender_name: { $in: targetSenders }
    }).lean();

    if (validationEntries.length === 0) {
      return res.json({ success: true, synced: false, message: 'Tidak ada entri validasi yang cocok', uploaded: 0 });
    }

    const googleApiKey = process.env.GOOGLE_SHEETS_API_KEY || '';

    let totalUpserted = 0;
    let totalDeleted = 0;
    let totalSkipped = 0;
    const syncedSenders = [];
    const skippedSenders = [];

    for (const entry of validationEntries) {
      if (!hasValidSpreadsheetConfig(entry)) {
        skippedSenders.push({ sender: entry.sender_name, reason: 'Tidak ada URL spreadsheet yang valid dikonfigurasi' });
        totalSkipped++;
        continue;
      }

      const spreadsheetConfig = resolveSpreadsheetConfig(entry);
      if (!spreadsheetConfig) {
        skippedSenders.push({ sender: entry.sender_name, reason: 'Tidak dapat menyelesaikan konfigurasi spreadsheet' });
        totalSkipped++;
        continue;
      }

      const { spreadsheetId, worksheetName, gid } = spreadsheetConfig;
      const targetProject = entry.project_name || project;
      const targetModel = getModel(targetProject);

      const fetchResult = await fetchSpreadsheetData(spreadsheetId, worksheetName, googleApiKey, gid);
      if (!fetchResult.data || fetchResult.data.length < 2) {
        skippedSenders.push({ sender: entry.sender_name, reason: fetchResult.error || 'Tidak ada data yang dikembalikan dari spreadsheet' });
        totalSkipped++;
        continue;
      }

      const sheetValues = fetchResult.data;
      const rawHeaders = sheetValues[0];
      const headers = rawHeaders.map(normalizeHeader);
      const dataRows = sheetValues.slice(1);

      const ordersPayload = [];
      const sheetIdSet = new Set();

      for (const row of dataRows) {
        if (isRowEmpty(row) || isRowAllRef(row)) continue;
        const paddedRow = headers.map((_, i) => (row[i] !== undefined ? row[i] : ''));
        const order = transformSheetRowToOrder(headers, paddedRow);
        if (!order.merchant_order_id || sheetIdSet.has(order.merchant_order_id)) continue;
        sheetIdSet.add(order.merchant_order_id);
        ordersPayload.push(order);
      }

      if (ordersPayload.length === 0) {
        skippedSenders.push({ sender: entry.sender_name, reason: 'Tidak ada baris valid yang ditemukan di sheet setelah parsing' });
        totalSkipped++;
        continue;
      }

      const upsertOps = ordersPayload.map(item => {
        const updateFields = {};
        UPDATABLE_FIELDS.forEach(field => {
          if (item[field] !== undefined) updateFields[field] = item[field];
        });
        return {
          updateOne: {
            filter: { merchant_order_id: item.merchant_order_id },
            update: { $set: updateFields },
            upsert: true,
          }
        };
      });

      try {
        const upsertResult = await targetModel.bulkWrite(upsertOps, { ordered: false });
        const upsertedCount = (upsertResult.upsertedCount || 0) + (upsertResult.modifiedCount || 0);

        const deleteResult = await targetModel.deleteMany({
          sender_name: entry.sender_name,
          merchant_order_id: { $nin: Array.from(sheetIdSet) },
          is_completed: { $ne: true },
        });

        totalUpserted += upsertedCount;
        totalDeleted += deleteResult.deletedCount || 0;
        syncedSenders.push(entry.sender_name);
      } catch (bulkErr) {
        skippedSenders.push({ sender: entry.sender_name, reason: `DB write error: ${bulkErr.message}` });
        totalSkipped++;
      }
    }

    return res.json({
      success: true,
      synced: syncedSenders.length > 0,
      uploaded: totalUpserted,
      deleted: totalDeleted,
      skipped: totalSkipped,
      syncedSenders,
      skippedSenders: skippedSenders.map(s => typeof s === 'string' ? { sender: s, reason: 'unknown' } : s),
      debug: skippedSenders.length > 0 ? skippedSenders.map(s => typeof s === 'string' ? s : `${s.sender}: ${s.reason}`) : undefined,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Sinkronisasi dari spreadsheet gagal', error: error.message });
  }
};

exports.uploadMerchantOrders = async (req, res) => {
  try {
    const { project } = req.params;
    const { data } = req.body;

    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ success: false, message: 'No data provided or invalid format' });
    }

    const seenIds = new Set();
    const uniqueData = [];

    for (const item of data) {
      const id = item.merchant_order_id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      uniqueData.push(item);
    }

    if (uniqueData.length === 0) {
      return res.json({ success: true, message: 'Upload completed', count: 0, inserted: 0, updated: 0, collection: `${project}_merchant_orders` });
    }

    const Model = getModel(project);

    const bulkOps = uniqueData.map(item => {
      const updateFields = {};
      UPDATABLE_FIELDS.forEach(field => {
        if (item[field] !== undefined) updateFields[field] = item[field];
      });
      return {
        updateOne: {
          filter: { merchant_order_id: item.merchant_order_id },
          update: { $set: updateFields },
          upsert: true,
        }
      };
    });

    const result = await Model.bulkWrite(bulkOps, { ordered: false });

    res.json({
      success: true,
      message: 'Upload completed',
      count: (result.upsertedCount || 0) + (result.modifiedCount || 0),
      inserted: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
      collection: `${project}_merchant_orders`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to upload merchant orders', error: error.message });
  }
};

exports.getAllMerchantOrdersAdmin = async (req, res) => {
  try {
    const { project } = req.params;
    const Model = getModel(project);
    const data = await Model.find().sort({ createdAt: -1 });
    res.json({ success: true, count: data.length, data, collection: `${project}_merchant_orders` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch merchant orders', error: error.message });
  }
};

exports.getAllMerchantOrders = async (req, res) => {
  try {
    const { project } = req.params;
    const { driver_id } = req.mitra;
    const { include_completed } = req.query;
    const Model = getModel(project);
    const driverProjects = await getDriverProjects(project, driver_id);

    const senderFilter = driverProjects && driverProjects.length > 0
      ? { sender_name: { $in: driverProjects } }
      : {};

    if (include_completed === 'true') {
      const completedData = await Model.find({
        ...senderFilter,
        is_completed: true,
      }).sort({ createdAt: -1 }).limit(200);
      return res.json({
        success: true,
        count: completedData.length,
        data: completedData,
        collection: `${project}_merchant_orders`
      });
    }

    const activeData = await Model.find({
      ...senderFilter,
      is_completed: { $ne: true },
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: activeData.length,
      data: activeData,
      collection: `${project}_merchant_orders`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch merchant orders', error: error.message });
  }
};

exports.migrateCompletedStatus = async (req, res) => {
  try {
    const { project } = req.params;
    const collection = mongoose.connection.db.collection(`${project}_merchant_orders`);

    const normalizeResult = await collection.updateMany(
      { $or: [{ is_completed: null }, { is_completed: { $exists: false } }] },
      { $set: { is_completed: false } }
    );

    const markResult = await collection.updateMany(
      {
        is_completed: { $ne: true },
        completed_blitz_status: { $in: TRULY_COMPLETED_BLITZ_STATUSES },
      },
      { $set: { is_completed: true } }
    );

    res.json({
      success: true,
      message: 'Migration completed',
      normalized: normalizeResult.modifiedCount,
      marked: markResult.modifiedCount,
      modified: normalizeResult.modifiedCount + markResult.modifiedCount
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Migration failed', error: error.message });
  }
};

exports.markOrdersCompletedBulk = async (req, res) => {
  try {
    const { project } = req.params;
    const { completedMap } = req.body;

    if (!completedMap || typeof completedMap !== 'object' || Object.keys(completedMap).length === 0) {
      return res.status(400).json({ success: false, message: 'completedMap is required' });
    }

    const validEntries = Object.entries(completedMap).filter(([, info]) =>
      isBlitzStatusTrulyCompleted(info.order_status)
    );

    if (validEntries.length === 0) {
      return res.json({ success: true, matched: 0, modified: 0, message: 'No orders with completed blitz status' });
    }

    const collection = mongoose.connection.db.collection(`${project}_merchant_orders`);
    const bulkOps = validEntries.map(([merchantOrderId, info]) => ({
      updateOne: {
        filter: { merchant_order_id: merchantOrderId, is_completed: { $ne: true } },
        update: {
          $set: {
            is_completed: true,
            completed_blitz_status: info.order_status || null,
            completed_batch_status: info.batch_status || null,
            completed_batch_id: info.batch_id || null,
            completed_driver_name: info.driver_name || null,
            completed_driver_contact: info.driver_contact || null,
            completed_awb_number: info.awb_number || null,
          }
        }
      }
    }));

    const result = await collection.bulkWrite(bulkOps, { ordered: false });

    res.json({
      success: true,
      matched: result.matchedCount,
      modified: result.modifiedCount
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to mark orders completed', error: error.message });
  }
};

exports.deleteAllMerchantOrders = async (req, res) => {
  try {
    const { project } = req.params;
    const Model = getModel(project);
    const result = await Model.deleteMany({});
    res.json({ success: true, message: 'All merchant orders deleted successfully', deletedCount: result.deletedCount, collection: `${project}_merchant_orders` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete merchant orders', error: error.message });
  }
};

exports.deleteBySenderNames = async (req, res) => {
  try {
    const { project } = req.params;
    const { senderNames } = req.body;

    if (!senderNames || !Array.isArray(senderNames) || senderNames.length === 0) {
      return res.status(400).json({ success: false, message: 'senderNames array is required' });
    }

    const uniqueSenderNames = [...new Set(senderNames.map(s => String(s).trim()).filter(Boolean))];
    const Model = getModel(project);
    const result = await Model.deleteMany({ sender_name: { $in: uniqueSenderNames } });

    res.json({
      success: true,
      message: 'Orders deleted by sender names',
      deletedCount: result.deletedCount,
      senderNames: uniqueSenderNames,
      collection: `${project}_merchant_orders`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete orders by sender names', error: error.message });
  }
};

exports.getMerchantOrderById = async (req, res) => {
  try {
    const { project, id } = req.params;
    const Model = getModel(project);
    const data = await Model.findById(id);
    if (!data) return res.status(404).json({ success: false, message: 'Merchant order not found' });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch merchant order', error: error.message });
  }
};

exports.updateMerchantOrder = async (req, res) => {
  try {
    const { project, id } = req.params;
    const updateData = req.body;
    const Model = getModel(project);
    const data = await Model.findByIdAndUpdate(id, { $set: updateData }, { new: true, runValidators: false });
    if (!data) return res.status(404).json({ success: false, message: 'Merchant order not found' });
    res.json({ success: true, message: 'Merchant order updated successfully', data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update merchant order', error: error.message });
  }
};

exports.deleteMerchantOrder = async (req, res) => {
  try {
    const { project, id } = req.params;
    const Model = getModel(project);
    const data = await Model.findByIdAndDelete(id);
    if (!data) return res.status(404).json({ success: false, message: 'Merchant order not found' });
    res.json({ success: true, message: 'Merchant order deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete merchant order', error: error.message });
  }
};

exports.validateSender = async (req, res) => {
  try {
    const { senderName } = req.body;
    if (!senderName) return res.status(400).json({ success: false, message: 'Sender name is required' });
    const ValidationModel = getAdminPanelValidationModel();
    const validation = await ValidationModel.findOne({ sender_name: senderName });
    if (!validation) {
      return res.status(404).json({ success: false, message: `Sender "${senderName}" not registered in AdminPanel Validations` });
    }
    res.json({ success: true, message: 'Sender validated successfully', data: validation });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to validate sender', error: error.message });
  }
};

exports.validateMultipleSenders = async (req, res) => {
  try {
    const { senderNames } = req.body;
    if (!senderNames || !Array.isArray(senderNames) || senderNames.length === 0) {
      return res.status(400).json({ success: false, message: 'senderNames array is required' });
    }
    const ValidationModel = getAdminPanelValidationModel();
    const uniqueSenderNames = [...new Set(senderNames)];
    const validationEntries = await ValidationModel.find({ sender_name: { $in: uniqueSenderNames } });
    const validationMap = {};
    validationEntries.forEach(entry => { validationMap[entry.sender_name] = entry; });
    const invalidSenders = uniqueSenderNames.filter(name => !validationMap[name]);
    if (invalidSenders.length > 0) {
      return res.status(404).json({
        success: false,
        message: `Sender berikut tidak terdaftar di AdminPanel Validations: ${invalidSenders.join(', ')}`,
        invalidSenders
      });
    }
    res.json({ success: true, message: 'All senders validated successfully', data: validationMap });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to validate senders', error: error.message });
  }
};

exports.getSenderCoordinates = async (req, res) => {
  try {
    const { senderNames } = req.body;
    if (!senderNames || !Array.isArray(senderNames) || senderNames.length === 0) {
      return res.status(400).json({ success: false, message: 'senderNames array is required' });
    }
    const ValidationModel = getAdminPanelValidationModel();
    const uniqueSenderNames = [...new Set(senderNames.filter(Boolean))];
    const validationEntries = await ValidationModel.find(
      { sender_name: { $in: uniqueSenderNames } },
      { sender_name: 1, location: 1, business: 1, city: 1, service_type: 1, business_hub: 1 }
    );
    const coordinatesMap = {};
    const foundNames = [];
    const notFoundNames = [];
    validationEntries.forEach(entry => {
      if (entry.location?.coordinates?.length === 2) {
        const [lng, lat] = entry.location.coordinates;
        if (lat && lng && lat !== 0 && lng !== 0) {
          coordinatesMap[entry.sender_name] = {
            lat, lng,
            business: entry.business,
            city: entry.city,
            service_type: entry.service_type,
            business_hub: entry.business_hub,
            location: entry.location
          };
          foundNames.push(entry.sender_name);
        } else {
          notFoundNames.push(entry.sender_name);
        }
      } else {
        notFoundNames.push(entry.sender_name);
      }
    });
    uniqueSenderNames.forEach(name => {
      if (!coordinatesMap[name] && !notFoundNames.includes(name)) notFoundNames.push(name);
    });
    res.json({
      success: true,
      data: coordinatesMap,
      found: foundNames,
      notFound: notFoundNames,
      totalRequested: uniqueSenderNames.length,
      totalFound: foundNames.length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get sender coordinates', error: error.message });
  }
};

exports.markOrdersCompleted = async (project, completedOrdersMap) => {
  if (!project || !completedOrdersMap || Object.keys(completedOrdersMap).length === 0) return;
  try {
    const validEntries = Object.entries(completedOrdersMap).filter(([, info]) =>
      isBlitzStatusTrulyCompleted(info.order_status)
    );
    if (validEntries.length === 0) return;
    const collection = mongoose.connection.db.collection(`${project}_merchant_orders`);
    const bulkOps = validEntries.map(([merchantOrderId, info]) => ({
      updateOne: {
        filter: { merchant_order_id: merchantOrderId, is_completed: false },
        update: {
          $set: {
            is_completed: true,
            completed_blitz_status: info.order_status || null,
            completed_batch_status: info.batch_status || null,
            completed_batch_id: info.batch_id || null,
            completed_driver_name: info.driver_name || null,
            completed_driver_contact: info.driver_contact || null,
            completed_awb_number: info.awb_number || null,
          }
        }
      }
    }));
    if (bulkOps.length > 0) await collection.bulkWrite(bulkOps, { ordered: false });
  } catch {}
};

const searchOrdersInBlitz = async (merchantOrderIds, authHeader) => {
  try {
    const res = await axios.post(
      `${API_BASE}/api/blitz-proxy/search-orders`,
      { merchantOrderIds },
      { headers: { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: authHeader } : {}) }, timeout: 60000 }
    );
    if (res.data.success) return res.data.data || {};
    return {};
  } catch {
    return {};
  }
};

exports.assignWithBlitz = async (req, res) => {
  try {
    const { project } = req.params;
    const { orderIds, driverId, driverName, driverPhone, activeBatchId, validationData: rawValidationData, batchOnly } = req.body;
    const isBatchOnly = batchOnly === true || batchOnly === 'true';

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No order IDs provided' });
    }

    if (!isBatchOnly && (!driverId || !driverName || !driverPhone)) {
      return res.status(400).json({ success: false, message: 'Driver information incomplete' });
    }

    const validationData = normalizeValidationData(rawValidationData);

    if (!validationData) {
      return res.status(400).json({ success: false, message: 'Validation data is required and must contain location coordinates' });
    }

    if (
      !validationData.location ||
      !Array.isArray(validationData.location.coordinates) ||
      validationData.location.coordinates.length !== 2
    ) {
      return res.status(400).json({ success: false, message: 'Validation data must contain valid location coordinates' });
    }

    const authorizationHeader = req.headers.authorization;
    const Model = getModel(project);

    const objectIds = orderIds.reduce((acc, id) => {
      try { acc.push(new mongoose.Types.ObjectId(id)); } catch {}
      return acc;
    }, []);

    const ordersToAssign = await Model.find({ _id: { $in: objectIds }, is_completed: false }).lean();

    if (ordersToAssign.length === 0) {
      return res.status(404).json({ success: false, message: 'No matching active orders found' });
    }

    const invalidOrders = [];
    for (const order of ordersToAssign) {
      const errors = validateBlitzRequiredFields(order);
      if (errors.length > 0) invalidOrders.push({ merchantOrderId: order.merchant_order_id, errors });
    }

    if (invalidOrders.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot assign: ${invalidOrders.length} order(s) have missing or invalid required fields`,
        invalidOrders,
        suggestion: 'Please check and fix the order data before assigning.'
      });
    }

    const uniqueSenderNames = [...new Set(ordersToAssign.map(o => o.sender_name).filter(Boolean))];
    const accountBySender = await getAccountBySenderNames(project, uniqueSenderNames);

    const forwardHeaders = {
      'Content-Type': 'application/json',
      ...(authorizationHeader ? { Authorization: authorizationHeader } : {})
    };

    const [lon, lat] = validationData.location.coordinates;
    const hubId = validationData.business_hub;

    const merchantOrderIds = ordersToAssign.map(o => o.merchant_order_id);
    const blitzSearchResult = await searchOrdersInBlitz(merchantOrderIds, authorizationHeader);

    const existingBatchIds = [...new Set(
      Object.values(blitzSearchResult)
        .map(r => r?.batch_id)
        .filter(b => b && b > 0)
    )];

    if (!isBatchOnly && existingBatchIds.length > 0) {
      const targetBatchId = existingBatchIds[0];

      try {
        const generateAssignRes = await axios.post(
          `${API_BASE}/api/blitz-proxy/generate-and-assign`,
          { batchId: targetBatchId, driverId, lat, lon, project },
          { headers: forwardHeaders, timeout: 120000 }
        );

        if (generateAssignRes.data.success) {
          return res.json({
            success: true,
            message: `Route generated and driver assigned to batch #${targetBatchId}`,
            assignedCount: ordersToAssign.length,
            batchId: targetBatchId,
            addedToExistingBatch: true,
            blitzSynced: true,
            batchOnly: false,
            driverInfo: {
              driverId,
              driverName,
              assignmentId: generateAssignRes.data.assignmentId,
            },
          });
        }
      } catch (generateErr) {
        const generateErrData = generateErr.response?.data;
        if (generateErrData?.blitz_generate_error === true || generateErrData?.errorCode === 40002) {
          return res.status(400).json({
            success: false,
            message: generateErrData.message || 'Generate route gagal karena koordinat tidak valid.',
            errorCode: 40002,
            blitz_generate_error: true,
            blitz_error: generateErrData.blitz_error || null,
          });
        }
      }
    }

    if (!isBatchOnly && activeBatchId) {
      try {
        const validateResponse = await axios.post(
          `${API_BASE}/api/blitz-proxy/validate-batch-orders`,
          { sequenceType: 1, batchId: activeBatchId, merchantOrderIds, hubId },
          { headers: forwardHeaders, timeout: 60000 }
        );

        if (validateResponse.data.result) {
          const addResponse = await axios.post(
            `${API_BASE}/api/blitz-proxy/add-batch-orders`,
            { sequenceType: 1, batchId: activeBatchId, merchantOrderIds, hubId },
            { headers: forwardHeaders, timeout: 60000 }
          );

          if (addResponse.data.result) {
            const generateAssignRes = await axios.post(
              `${API_BASE}/api/blitz-proxy/generate-and-assign`,
              { batchId: activeBatchId, driverId, lat, lon, project },
              { headers: forwardHeaders, timeout: 120000 }
            );

            return res.json({
              success: true,
              message: `Successfully added ${ordersToAssign.length} orders to existing batch`,
              assignedCount: ordersToAssign.length,
              batchId: activeBatchId,
              addedToExistingBatch: true,
              blitzSynced: true,
              batchOnly: false,
              driverInfo: {
                driverId,
                driverName,
                assignmentId: generateAssignRes.data?.assignmentId || null,
              },
            });
          }
        }
      } catch {}
    }

    let createBatchResponse;
    try {
      createBatchResponse = await axios.post(
        `${API_BASE}/api/blitz-proxy/create-batch-with-driver`,
        {
          orders: ordersToAssign,
          driverId, driverName, driverPhone,
          business: validationData.business,
          city: validationData.city,
          serviceType: validationData.service_type,
          hubId,
          coordinates: validationData.location.coordinates,
          project, batchOnly: isBatchOnly, accountBySender
        },
        { headers: forwardHeaders, timeout: 180000 }
      );
    } catch (blitzError) {
      const blitzData = blitzError.response?.data;
      const blitzMsg = blitzData?.message || blitzError.message;
      return res.status(blitzError.response?.status || 500).json({
        success: false,
        message: blitzMsg,
        errorCode: blitzData?.errorCode || null,
        blitz_generate_error: blitzData?.blitz_generate_error === true,
        blitz_error: blitzData,
        validation_errors: blitzData?.validation_errors || [],
        assignedCount: objectIds.length
      });
    }

    if (createBatchResponse.data.success) {
      return res.json({
        success: true,
        message: isBatchOnly
          ? `Batch berhasil dibuat untuk ${ordersToAssign.length} order (tanpa assign driver)`
          : `Successfully created batch and assigned ${ordersToAssign.length} orders`,
        assignedCount: ordersToAssign.length,
        batchId: createBatchResponse.data.batchId,
        blitzSynced: true,
        batchOnly: isBatchOnly,
        uploaded: createBatchResponse.data.uploadedCount > 0,
        uploadedCount: createBatchResponse.data.uploadedCount || 0,
        skippedCount: createBatchResponse.data.skippedCount || 0,
        ...(!isBatchOnly && { driverInfo: { driverId, driverName, assignmentId: createBatchResponse.data.assignmentId } })
      });
    }

    return res.status(400).json({
      success: false,
      message: createBatchResponse.data.message || 'Batch creation failed',
      errorCode: createBatchResponse.data.errorCode || null,
      blitz_generate_error: createBatchResponse.data.blitz_generate_error === true,
      blitz_error: createBatchResponse.data.blitz_error || null,
      validation_errors: createBatchResponse.data.validation_errors || [],
      assignedCount: objectIds.length
    });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to assign orders', error: error.message });
  }
};