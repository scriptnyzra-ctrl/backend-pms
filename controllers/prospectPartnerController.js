const axios = require('axios');
const ProspectPartner = require('../models/ProspectPartner');

const GMAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const EXCEL_HEADER_MAP = {
  Full_Name: 'fullName',
  Phone_Number: 'phoneNumber',
  Email_Address: 'emailAddress',
  Domicile_Address: 'domicileAddress',
  Occupation: 'occupation',
  Company_Name: 'companyName',
  Work_Duration: 'workDuration',
  Proof_Image: 'proofImage',
  Preparation_Date: 'preparationDate',
  Assigned_To: 'assignedTo',
  Reason: 'notes',
  Notes: 'notes',
  Previous_Income: 'previousIncome',
  Performance_Rating: 'performanceRating',
  Status: 'eligibilityStatus',
};

const ELIGIBILITY_STATUSES = ['Eligible', 'Need Review', 'Not Eligible', 'Potential Partner'];
const PERFORMANCE_RATINGS = ['Basic', 'Standard', 'Advanced', 'Professional', 'Elite', ''];
const ASSIGNED_TO_OPTIONS = ['Putra', 'Septa', 'Fuja', 'Fitra', 'Arina', 'Jisman'];

const PROVINCE_MAP = {
  'West Java': 'Jawa Barat',
  'Central Java': 'Jawa Tengah',
  'East Java': 'Jawa Timur',
  'Special Region of Yogyakarta': 'DI Yogyakarta',
  'Yogyakarta': 'DI Yogyakarta',
  'Special Capital Region of Jakarta': 'DKI Jakarta',
  'Jakarta': 'DKI Jakarta',
  'West Kalimantan': 'Kalimantan Barat',
  'Central Kalimantan': 'Kalimantan Tengah',
  'South Kalimantan': 'Kalimantan Selatan',
  'East Kalimantan': 'Kalimantan Timur',
  'North Kalimantan': 'Kalimantan Utara',
  'West Sumatra': 'Sumatera Barat',
  'North Sumatra': 'Sumatera Utara',
  'South Sumatra': 'Sumatera Selatan',
  'West Sulawesi': 'Sulawesi Barat',
  'Central Sulawesi': 'Sulawesi Tengah',
  'South Sulawesi': 'Sulawesi Selatan',
  'Southeast Sulawesi': 'Sulawesi Tenggara',
  'North Sulawesi': 'Sulawesi Utara',
  'West Nusa Tenggara': 'Nusa Tenggara Barat',
  'East Nusa Tenggara': 'Nusa Tenggara Timur',
  'Bangka Belitung Islands': 'Kepulauan Bangka Belitung',
  'Riau Islands': 'Kepulauan Riau',
  'North Maluku': 'Maluku Utara',
  'West Papua': 'Papua Barat',
  'Aceh': 'Aceh',
  'Bali': 'Bali',
  'Banten': 'Banten',
  'Bengkulu': 'Bengkulu',
  'Gorontalo': 'Gorontalo',
  'Jambi': 'Jambi',
  'Lampung': 'Lampung',
  'Maluku': 'Maluku',
  'Papua': 'Papua',
  'Riau': 'Riau',
};

const KABUPATEN_KOTA_MAP = {
  'West Jakarta': 'Kota Jakarta Barat',
  'East Jakarta': 'Kota Jakarta Timur',
  'South Jakarta': 'Kota Jakarta Selatan',
  'North Jakarta': 'Kota Jakarta Utara',
  'Central Jakarta': 'Kota Jakarta Pusat',
  'South Tangerang': 'Kota Tangerang Selatan',
  'South Tangerang City': 'Kota Tangerang Selatan',
  'Tangerang City': 'Kota Tangerang',
  'Bekasi City': 'Kota Bekasi',
  'Depok City': 'Kota Depok',
  'Bogor City': 'Kota Bogor',
  'Bandung City': 'Kota Bandung',
  'Surabaya City': 'Kota Surabaya',
  'Surabaya': 'Kota Surabaya',
  'Medan City': 'Kota Medan',
  'Medan': 'Kota Medan',
  'Semarang City': 'Kota Semarang',
  'Semarang': 'Kota Semarang',
  'Makassar City': 'Kota Makassar',
  'Makassar': 'Kota Makassar',
};

const DIRECTION_MAP = {
  'West': 'Barat',
  'East': 'Timur',
  'South': 'Selatan',
  'North': 'Utara',
  'Central': 'Tengah',
};

const JAKARTA_KECAMATAN_KOTA_MAP = {
  'cengkareng': 'Kota Jakarta Barat',
  'grogol petamburan': 'Kota Jakarta Barat',
  'tambora': 'Kota Jakarta Barat',
  'taman sari': 'Kota Jakarta Barat',
  'kebon jeruk': 'Kota Jakarta Barat',
  'kembangan': 'Kota Jakarta Barat',
  'palmerah': 'Kota Jakarta Barat',
  'kalideres': 'Kota Jakarta Barat',
  'penjaringan': 'Kota Jakarta Utara',
  'pademangan': 'Kota Jakarta Utara',
  'tanjung priok': 'Kota Jakarta Utara',
  'koja': 'Kota Jakarta Utara',
  'kelapa gading': 'Kota Jakarta Utara',
  'cilincing': 'Kota Jakarta Utara',
  'gambir': 'Kota Jakarta Pusat',
  'sawah besar': 'Kota Jakarta Pusat',
  'kemayoran': 'Kota Jakarta Pusat',
  'senen': 'Kota Jakarta Pusat',
  'cempaka putih': 'Kota Jakarta Pusat',
  'menteng': 'Kota Jakarta Pusat',
  'tanah abang': 'Kota Jakarta Pusat',
  'johar baru': 'Kota Jakarta Pusat',
  'matraman': 'Kota Jakarta Timur',
  'pulo gadung': 'Kota Jakarta Timur',
  'jatinegara': 'Kota Jakarta Timur',
  'duren sawit': 'Kota Jakarta Timur',
  'cakung': 'Kota Jakarta Timur',
  'pasar rebo': 'Kota Jakarta Timur',
  'ciracas': 'Kota Jakarta Timur',
  'cipayung': 'Kota Jakarta Timur',
  'kramat jati': 'Kota Jakarta Timur',
  'makasar': 'Kota Jakarta Timur',
  'kebayoran baru': 'Kota Jakarta Selatan',
  'kebayoran lama': 'Kota Jakarta Selatan',
  'pesanggrahan': 'Kota Jakarta Selatan',
  'cilandak': 'Kota Jakarta Selatan',
  'pasar minggu': 'Kota Jakarta Selatan',
  'jagakarsa': 'Kota Jakarta Selatan',
  'mampang prapatan': 'Kota Jakarta Selatan',
  'pancoran': 'Kota Jakarta Selatan',
  'tebet': 'Kota Jakarta Selatan',
  'setiabudi': 'Kota Jakarta Selatan',
};

const JAKARTA_AREA_KEYWORDS = {
  'jakarta barat': 'Kota Jakarta Barat',
  'jakbar': 'Kota Jakarta Barat',
  'jakarta utara': 'Kota Jakarta Utara',
  'jakut': 'Kota Jakarta Utara',
  'jakarta pusat': 'Kota Jakarta Pusat',
  'jakpus': 'Kota Jakarta Pusat',
  'jakarta timur': 'Kota Jakarta Timur',
  'jaktim': 'Kota Jakarta Timur',
  'jakarta selatan': 'Kota Jakarta Selatan',
  'jaksel': 'Kota Jakarta Selatan',
};

const parseExcelDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const num = Number(value);
  if (!isNaN(num) && num > 1000 && num < 100000) {
    const excelEpoch = new Date(1899, 11, 30);
    const date = new Date(excelEpoch.getTime() + num * 86400000);
    if (!isNaN(date.getTime())) return date;
  }
  const str = String(value).trim();
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed;
  const parts = str.split(/[\/\-\.]/);
  if (parts.length === 3) {
    const [a, b, c] = parts.map(Number);
    const attempts = [new Date(c, b - 1, a), new Date(c, a - 1, b), new Date(a, b - 1, c)];
    for (const d of attempts) {
      if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return d;
    }
  }
  return null;
};

const parseIncome = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/[Rp\s]/g, '').replace(/\./g, '').replace(/,/g, '');
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
};

const translateDirectional = (text) => {
  if (!text) return text;
  let result = text;
  for (const [eng, id] of Object.entries(DIRECTION_MAP)) {
    result = result.replace(new RegExp(`\\b${eng}\\b`, 'g'), id);
  }
  return result;
};

const normalizeProvinsi = (raw) => {
  if (!raw) return '';
  const cleaned = raw.replace(/\s+Province$/i, '').replace(/\s+Provinsi$/i, '').trim();
  if (PROVINCE_MAP[cleaned]) return PROVINCE_MAP[cleaned];
  if (PROVINCE_MAP[raw.trim()]) return PROVINCE_MAP[raw.trim()];
  return translateDirectional(cleaned);
};

const normalizeKabupatenKota = (raw) => {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (KABUPATEN_KOTA_MAP[trimmed]) return KABUPATEN_KOTA_MAP[trimmed];
  const withoutSuffix = trimmed.replace(/\s+City$/i, '').replace(/\s+Regency$/i, '').replace(/\s+District$/i, '').trim();
  if (KABUPATEN_KOTA_MAP[withoutSuffix]) return KABUPATEN_KOTA_MAP[withoutSuffix];
  if (/^Kota\s+/i.test(trimmed)) return 'Kota ' + trimmed.replace(/^Kota\s+/i, '').trim();
  if (/^Kabupaten\s+/i.test(trimmed)) return 'Kabupaten ' + trimmed.replace(/^Kabupaten\s+/i, '').trim();
  if (/\s+City$/i.test(trimmed)) return 'Kota ' + withoutSuffix;
  if (/\s+Regency$/i.test(trimmed)) return 'Kabupaten ' + withoutSuffix;
  return translateDirectional(withoutSuffix);
};

const normalizeKecamatan = (raw) => {
  if (!raw) return '';
  return translateDirectional(raw.replace(/^Kecamatan\s+/i, '').replace(/^Kec\.\s*/i, '').trim());
};

const normalizeKelurahan = (raw) => {
  if (!raw) return '';
  return translateDirectional(raw.replace(/^Kelurahan\s+/i, '').replace(/^Kel\.\s*/i, '').replace(/^Desa\s+/i, '').trim());
};

const normalizeFormattedAddress = (address) => {
  if (!address) return '';
  return address.replace(/,\s*Indonesia$/i, ', Indonesia').trim();
};

const normalizeIndonesianAddress = (components, formattedAddress) => {
  const get = (type) => components.find((c) => c.types.includes(type))?.long_name || '';
  return {
    kecamatan: normalizeKecamatan(get('administrative_area_level_3')),
    kelurahan: normalizeKelurahan(get('administrative_area_level_4') || get('sublocality_level_1')),
    kabupatenKota: normalizeKabupatenKota(get('administrative_area_level_2')),
    provinsi: normalizeProvinsi(get('administrative_area_level_1')),
    formattedAddress: normalizeFormattedAddress(formattedAddress),
  };
};

const extractAddressKeywords = (address) => {
  if (!address) return {};
  const lower = address.toLowerCase();
  for (const [keyword, kotaValue] of Object.entries(JAKARTA_AREA_KEYWORDS)) {
    if (lower.includes(keyword)) return { expectedKota: kotaValue, expectedProvinsi: 'DKI Jakarta' };
  }
  for (const [kecamatanName, kotaValue] of Object.entries(JAKARTA_KECAMATAN_KOTA_MAP)) {
    if (lower.includes(kecamatanName)) {
      return { expectedKota: kotaValue, expectedProvinsi: 'DKI Jakarta', expectedKecamatan: kecamatanName };
    }
  }
  return {};
};

const isGeocodeResultValid = (normalized, addressKeywords) => {
  if (!addressKeywords.expectedKota) return true;
  const normalizedKota = (normalized.kabupatenKota || '').toLowerCase();
  const expectedKota = addressKeywords.expectedKota.toLowerCase();
  if (normalizedKota && normalizedKota !== expectedKota) return false;
  if (addressKeywords.expectedKecamatan) {
    const normalizedKec = (normalized.kecamatan || '').toLowerCase();
    if (normalizedKec && !normalizedKec.includes(addressKeywords.expectedKecamatan)) return false;
  }
  return true;
};

const buildFallbackFromKeywords = (addressKeywords, latitude, longitude) => {
  if (!addressKeywords.expectedKota) return null;
  return {
    normalizedAddress: '',
    latitude,
    longitude,
    kecamatan: addressKeywords.expectedKecamatan
      ? addressKeywords.expectedKecamatan.replace(/\b\w/g, (c) => c.toUpperCase())
      : '',
    kelurahan: '',
    kabupatenKota: addressKeywords.expectedKota,
    provinsi: addressKeywords.expectedProvinsi || 'DKI Jakarta',
    formattedAddress: '',
    placeId: '',
    geocodedAt: new Date(),
    geocodeFailed: false,
  };
};

const attemptGeocode = async (query, addressKeywords = {}) => {
  if (!query || !GMAPS_API_KEY) return null;
  try {
    const params = { address: query, key: GMAPS_API_KEY, language: 'id', region: 'id', components: 'country:ID' };
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', { params, timeout: 15000 });
    if (data.status === 'REQUEST_DENIED' || data.status === 'OVER_QUERY_LIMIT') return null;
    if (data.status !== 'OK' || !data.results?.length) return null;
    for (const resultCandidate of data.results) {
      const normalized = normalizeIndonesianAddress(resultCandidate.address_components, resultCandidate.formatted_address);
      const lat = resultCandidate.geometry.location.lat;
      const lng = resultCandidate.geometry.location.lng;
      if (!isGeocodeResultValid(normalized, addressKeywords)) {
        const fallback = buildFallbackFromKeywords(addressKeywords, lat, lng);
        if (fallback) return fallback;
        continue;
      }
      return {
        normalizedAddress: normalized.formattedAddress,
        latitude: lat,
        longitude: lng,
        kecamatan: normalized.kecamatan,
        kelurahan: normalized.kelurahan,
        kabupatenKota: normalized.kabupatenKota,
        provinsi: normalized.provinsi,
        formattedAddress: normalized.formattedAddress,
        placeId: resultCandidate.place_id,
        geocodedAt: new Date(),
        geocodeFailed: false,
      };
    }
    const firstResult = data.results[0];
    const lat = firstResult.geometry.location.lat;
    const lng = firstResult.geometry.location.lng;
    const fallback = buildFallbackFromKeywords(addressKeywords, lat, lng);
    if (fallback) return fallback;
    return null;
  } catch {
    return null;
  }
};

const geocodeAddress = async (address) => {
  if (!address) return null;
  const addressKeywords = extractAddressKeywords(address);
  let result = await attemptGeocode(address, addressKeywords);
  if (result) return result;
  const simplified = address.replace(/rt\s*\d+\s*/gi, '').replace(/rw\s*\d+\s*/gi, '').replace(/no\.?\s*\d+[\w-]*\s*/gi, '').replace(/\s+/g, ' ').trim();
  if (simplified && simplified !== address) {
    result = await attemptGeocode(simplified, addressKeywords);
    if (result) return result;
  }
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 2) {
    result = await attemptGeocode(parts.slice(-3).join(', '), addressKeywords);
    if (result) return result;
  }
  if (parts.length > 1) {
    result = await attemptGeocode(parts.slice(-2).join(', '), addressKeywords);
    if (result) return result;
  }
  return null;
};

const mapExcelRow = (row) => {
  const mapped = {};
  for (const [excelKey, dbKey] of Object.entries(EXCEL_HEADER_MAP)) {
    const value = row[excelKey];
    if (value === undefined || value === null) continue;
    if (dbKey === 'preparationDate') {
      mapped[dbKey] = parseExcelDate(value);
    } else if (dbKey === 'previousIncome') {
      mapped[dbKey] = parseIncome(value);
    } else {
      mapped[dbKey] = String(value).trim();
    }
  }
  if (!mapped.notes) mapped.notes = '';
  return mapped;
};

const checkDuplicates = async (partnersData) => {
  const duplicates = { inPayload: [], inDatabase: [], total: 0 };
  const seenPhones = new Map();
  partnersData.forEach((partner, index) => {
    if (!partner.phoneNumber) return;
    if (seenPhones.has(partner.phoneNumber)) {
      duplicates.inPayload.push({ row: index + 2, data: partner, duplicateFields: ['phoneNumber'] });
    } else {
      seenPhones.set(partner.phoneNumber, index + 2);
    }
  });
  const phoneList = partnersData.map((p) => p.phoneNumber).filter(Boolean);
  if (phoneList.length > 0) {
    const existing = await ProspectPartner.find({ phoneNumber: { $in: phoneList } }).lean();
    const existingSet = new Set(existing.map((p) => p.phoneNumber));
    partnersData.forEach((partner, index) => {
      if (partner.phoneNumber && existingSet.has(partner.phoneNumber)) {
        duplicates.inDatabase.push({ row: index + 2, data: partner, duplicateFields: ['phoneNumber'] });
      }
    });
  }
  duplicates.total = duplicates.inPayload.length + duplicates.inDatabase.length;
  return duplicates;
};

const enrichPartner = async (partner) => {
  const geoResult = await geocodeAddress(partner.domicileAddress);
  const geo = { originalAddress: partner.domicileAddress || '', ...(geoResult ? geoResult : { geocodeFailed: true }) };
  return { ...partner, eligibilityStatus: partner.eligibilityStatus || 'Need Review', geo };
};

exports.uploadProspectPartners = async (req, res) => {
  try {
    const rawData = req.body;
    if (!Array.isArray(rawData) || rawData.length === 0) {
      return res.status(400).json({ success: false, message: 'No data provided' });
    }
    const hasExcelHeaders = Object.keys(rawData[0]).some((k) => k in EXCEL_HEADER_MAP);
    const partnersData = hasExcelHeaders ? rawData.map(mapExcelRow) : rawData;
    const invalidRows = partnersData.map((p, i) => (!p.phoneNumber || String(p.phoneNumber).trim() === '' ? i + 2 : null)).filter(Boolean);
    if (invalidRows.length > 0) {
      return res.status(400).json({ success: false, message: `Field 'Phone_Number' wajib diisi. Data kosong di baris: ${invalidRows.join(', ')}` });
    }
    const duplicates = await checkDuplicates(partnersData);
    if (duplicates.total > 0) {
      return res.status(409).json({ success: false, message: `Ditemukan ${duplicates.total} data duplikat`, duplicates });
    }
    const BATCH_SIZE = 5;
    const enriched = [];
    for (let i = 0; i < partnersData.length; i += BATCH_SIZE) {
      const batch = partnersData.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(enrichPartner));
      enriched.push(...results);
    }
    const geocodedCount = enriched.filter((p) => !p.geo.geocodeFailed).length;
    const result = await ProspectPartner.insertMany(enriched, { ordered: false });
    res.status(201).json({ success: true, message: `Berhasil mengupload ${result.length} data prospect partner (geocoded: ${geocodedCount})`, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal mengupload data', error: error.message });
  }
};

exports.getAllProspectPartners = async (req, res) => {
  try {
    const data = await ProspectPartner.find().sort({ createdAt: -1 }).lean();
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal mengambil data', error: error.message });
  }
};

exports.updateProspectPartner = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    if (!updateData.phoneNumber || String(updateData.phoneNumber).trim() === '') {
      return res.status(400).json({ success: false, message: 'Phone Number wajib diisi' });
    }
    if (updateData.eligibilityStatus && !ELIGIBILITY_STATUSES.includes(updateData.eligibilityStatus)) {
      return res.status(400).json({ success: false, message: 'Status tidak valid' });
    }
    if (updateData.performanceRating && !PERFORMANCE_RATINGS.includes(updateData.performanceRating)) {
      return res.status(400).json({ success: false, message: 'Performance rating tidak valid' });
    }
    if (updateData.assignedTo && !ASSIGNED_TO_OPTIONS.includes(updateData.assignedTo)) {
      return res.status(400).json({ success: false, message: 'Assigned To tidak valid' });
    }
    if (updateData.previousIncome !== undefined) {
      updateData.previousIncome = parseIncome(updateData.previousIncome);
    }
    if (updateData.preparationDate !== undefined) {
      updateData.preparationDate = parseExcelDate(updateData.preparationDate);
    }
    const existing = await ProspectPartner.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
    const duplicate = await ProspectPartner.findOne({ _id: { $ne: id }, phoneNumber: updateData.phoneNumber });
    if (duplicate) {
      return res.status(409).json({ success: false, message: 'Phone Number sudah digunakan oleh data lain' });
    }
    const addressChanged = updateData.domicileAddress && updateData.domicileAddress !== existing.domicileAddress;
    if (addressChanged) {
      const geoResult = await geocodeAddress(updateData.domicileAddress);
      updateData.geo = { originalAddress: updateData.domicileAddress, ...(geoResult || { geocodeFailed: true }) };
    }
    if (!updateData.eligibilityStatus) updateData.eligibilityStatus = existing.eligibilityStatus;
    const updated = await ProspectPartner.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });
    res.status(200).json({ success: true, message: 'Data berhasil diperbarui', data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal memperbarui data', error: error.message });
  }
};

exports.deleteProspectPartner = async (req, res) => {
  try {
    const { id } = req.params;
    const partner = await ProspectPartner.findById(id);
    if (!partner) return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
    await ProspectPartner.findByIdAndDelete(id);
    res.status(200).json({ success: true, message: 'Data berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal menghapus data', error: error.message });
  }
};

exports.bulkDeleteProspectPartners = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada ID yang diberikan' });
    }
    const result = await ProspectPartner.deleteMany({ _id: { $in: ids } });
    res.status(200).json({ success: true, message: `Berhasil menghapus ${result.deletedCount} data` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal menghapus data', error: error.message });
  }
};

exports.getMapDistribution = async (req, res) => {
  try {
    const { provinsi, kabupatenKota, kecamatan, eligibilityStatus, occupation, companyName, geocodeStatus } = req.query;
    const filter = {};
    if (geocodeStatus === 'berhasil') {
      filter['geo.geocodeFailed'] = { $ne: true };
      filter['geo.latitude'] = { $exists: true, $ne: null };
    } else if (geocodeStatus === 'gagal') {
      filter['geo.geocodeFailed'] = true;
    } else {
      filter['geo.latitude'] = { $exists: true, $ne: null };
      filter['geo.geocodeFailed'] = { $ne: true };
    }
    if (provinsi) filter['geo.provinsi'] = new RegExp(provinsi, 'i');
    if (kabupatenKota) filter['geo.kabupatenKota'] = new RegExp(kabupatenKota, 'i');
    if (kecamatan) filter['geo.kecamatan'] = new RegExp(kecamatan, 'i');
    if (eligibilityStatus) filter.eligibilityStatus = eligibilityStatus;
    if (occupation) filter.occupation = new RegExp(occupation, 'i');
    if (companyName) filter.companyName = new RegExp(companyName, 'i');
    const data = await ProspectPartner.find(filter)
      .select('fullName phoneNumber emailAddress occupation companyName eligibilityStatus geo')
      .lean();
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal mengambil data distribusi', error: error.message });
  }
};

exports.getMapSummary = async (req, res) => {
  try {
    const [byStatus, byProvinsi, byOccupation, byCompany, total, geocoded] = await Promise.all([
      ProspectPartner.aggregate([{ $group: { _id: '$eligibilityStatus', count: { $sum: 1 } } }]),
      ProspectPartner.aggregate([
        { $match: { 'geo.provinsi': { $exists: true, $ne: '' } } },
        { $group: { _id: '$geo.provinsi', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      ProspectPartner.aggregate([
        { $match: { occupation: { $exists: true, $ne: '' } } },
        { $group: { _id: '$occupation', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      ProspectPartner.aggregate([
        { $match: { companyName: { $exists: true, $ne: '' } } },
        { $group: { _id: '$companyName', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      ProspectPartner.countDocuments(),
      ProspectPartner.countDocuments({ 'geo.geocodeFailed': { $ne: true }, 'geo.latitude': { $exists: true, $ne: null } }),
    ]);
    res.status(200).json({ success: true, data: { total, geocoded, byStatus, byProvinsi, byOccupation, byCompany } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal mengambil summary', error: error.message });
  }
};

exports.retryGeocode = async (req, res) => {
  try {
    const { id } = req.params;
    const partner = await ProspectPartner.findById(id);
    if (!partner) return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
    const address = partner.domicileAddress || partner.geo?.originalAddress;
    if (!address) return res.status(400).json({ success: false, message: 'Tidak ada alamat untuk di-geocode' });
    const geoResult = await geocodeAddress(address);
    if (!geoResult) return res.status(422).json({ success: false, message: 'Geocoding gagal untuk alamat ini' });
    partner.geo = { ...(partner.geo?.toObject?.() || partner.geo || {}), originalAddress: address, ...geoResult };
    await partner.save();
    res.status(200).json({ success: true, message: 'Geocoding berhasil', data: partner });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal retry geocoding', error: error.message });
  }
};