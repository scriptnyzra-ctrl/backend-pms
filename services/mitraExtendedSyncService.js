const axios = require('axios');
const MitraExtended = require('../models/MitraExtended');

let fetchNikFromLark;
try {
  const larkController = require('../controllers/larkController');
  fetchNikFromLark = larkController.fetchNikFromLark;
  if (!fetchNikFromLark) throw new Error('fetchNikFromLark not exported');
} catch (err) {
  console.error('Warning: larkController import failed:', err.message);
  fetchNikFromLark = async () => [];
}

const RIDEBLITZ_BASE_URL = process.env.RIDEBLITZ_BASE_URL || 'https://driver-api.rideblitz.id';
const RIDEBLITZ_BANK_API_URL = process.env.RIDEBLITZ_BANK_API_URL || 'https://user.rideblitz.id/v1/app/users/bank_detail/drivers';
const RIDEBLITZ_USERNAME = process.env.RIDEBLITZ_USERNAME || 'merapi';
const RIDEBLITZ_PASSWORD = process.env.RIDEBLITZ_PASSWORD || 'qRKzNbami4';

const LOGIN_TIMEOUT = 15000;
const FETCH_TIMEOUT = 60000;
const PROFILE_TIMEOUT = 20000;
const BATCH_SIZE = 50;
const CONCURRENT_REQUESTS = 5;

let cachedToken = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const loginToRideblitz = async () => {
  console.log('[Sync] Logging in to Rideblitz...');
  const response = await axios.post(
    `${RIDEBLITZ_BASE_URL}/panel/login`,
    { username: RIDEBLITZ_USERNAME, password: RIDEBLITZ_PASSWORD },
    { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: LOGIN_TIMEOUT }
  );
  const data = response.data;
  if (!data?.result || !data?.data?.access_token) {
    throw new Error(`Rideblitz login failed: ${JSON.stringify(data)}`);
  }
  cachedToken = data.data.access_token;
  console.log('[Sync] Login success');
  return cachedToken;
};

const invalidateToken = () => { cachedToken = null; };

const fetchPage1 = async (token) => {
  const params = new URLSearchParams();
  params.append('sort', '-1');
  [1, 2, 8, 3, 4, 5, 6, 7].forEach(s => params.append('status', s));
  params.append('attendance', '');
  params.append('page', '1');
  params.append('offset', '100');
  params.append('term', '');
  params.append('app_version_name', '');
  params.append('bank_info_provided', 'undefined');

  const url = `${RIDEBLITZ_BASE_URL}/v2/panel/driver-list?${params.toString()}`;
  console.log('[Sync] Fetching page 1 from:', url);

  const response = await axios.get(url, {
    headers: { 'authorization': token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    timeout: FETCH_TIMEOUT
  });

  const data = response.data?.data || null;
  console.log('[Sync] Page 1 response summary:', {
    total_records: data?.total_records,
    total_pages: data?.total_pages,
    records_on_page: data?.records_on_page,
    drivers_count: data?.driver_list_response?.length
  });
  console.log('[Sync] Page 1 full raw response:', JSON.stringify(data, null, 2));
  return data;
};

const getStatusDisplay = (status) => {
  const map = {
    registered: 'Registered', active: 'Active', pending: 'Pending Verification',
    new: 'New', inactive: 'Inactive', banned: 'Banned', manual_verification: 'Manual Verification'
  };
  return map[status?.toLowerCase()] || status || '-';
};

const formatDateTime = (dateString) => {
  if (!dateString) return '-';
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '-';
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = date.getFullYear();
    const h = date.getHours();
    const min = String(date.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const fh = h % 12 || 12;
    return `${d}/${m}/${y} ${fh}:${min}${ampm}`;
  } catch { return '-'; }
};

const buildBaseProfile = (driverInfo) => {
  const d = driverInfo?.drivers || {};
  const state = d.account_state || {};
  return {
    driver_id: String(d.id),
    name: d.name || '',
    phone_number: d.phone_number || '',
    city: d.city_name || '',
    status: getStatusDisplay(state.status),
    attendance: d.attendance_status || '',
    otp: d.otp || '',
    bank_info_provided: d.bank_info_provided || false,
    app_version_name: d.app_version_name || '',
    app_version_code: d.app_version || '',
    app_android_version: d.app_android_version || '',
    android_version: d.android_version || '',
    last_active: formatDateTime(d.last_active),
    registered_at: formatDateTime(driverInfo?.registered_at),
    hubs: driverInfo?.hubs || '',
    businesses: driverInfo?.businesses || '',
    reason: d.reason || '',
    current_lat: null, current_lon: null,
    nik: '', sim_number: '', sim_expiry: '',
    bank_name: '', bank_account_holder: '', bank_account_number: '',
    hub_data: {}, business_data: {},
    lark_tanggal_keluar_unit: '', lark_nomor_plat: '', lark_merk_unit: '',
    lark_alamat: '', lark_tanggal_pengembalian_unit: '',
    lark_lama_pemakaian: '', lark_status: '',
    updated_at: new Date()
  };
};

const fetchBankDetails = async (userId, token) => {
  if (!userId) return null;
  try {
    const res = await axios.get(`${RIDEBLITZ_BANK_API_URL}/${userId}`, {
      headers: { 'authorization': token, 'Accept': 'application/json' },
      timeout: PROFILE_TIMEOUT
    });
    if (res.data?.result && res.data?.data) {
      return {
        bank_name: res.data.data.bank || '',
        bank_account_number: res.data.data.account_number || '',
        bank_account_holder: res.data.data.beneficiary_name || ''
      };
    }
    return null;
  } catch { return null; }
};

const fetchDriverProfile = async (driverId, userId, token) => {
  try {
    const res = await axios.get(`${RIDEBLITZ_BASE_URL}/panel/driver-profile/${driverId}`, {
      headers: { 'authorization': token, 'Accept': 'application/json' },
      timeout: PROFILE_TIMEOUT
    });
    if (!res.data?.result || !res.data?.data) return null;

    const data = res.data.data;
    const docs = data.driver_profile?.documents || [];
    const coords = data.current_cordinates || {};
    const hub = data.business_hub || {};
    const ktp = docs.find(d => d.fields?.key === 'ktp');
    const sim = docs.find(d => d.fields?.key === 'sim');
    const bank = await fetchBankDetails(userId, token);

    return {
      driver_id: String(driverId),
      current_lat: coords.lat || null,
      current_lon: coords.lon || null,
      nik: ktp?.fields?.value?.nik || '',
      sim_number: sim?.fields?.value?.sim || '',
      sim_expiry: sim?.fields?.value?.expiry_date || '',
      bank_name: bank?.bank_name || '',
      bank_account_holder: bank?.bank_account_holder || '',
      bank_account_number: bank?.bank_account_number || '',
      hub_data: hub.hub_data || {},
      business_data: hub.business_data || {}
    };
  } catch { return null; }
};

const matchLark = (profile, larkData) => {
  if (!profile?.nik || !larkData?.length) return null;
  const nik = String(profile.nik).trim();
  if (!nik || nik === '-') return null;
  const match = larkData.find(item => String(item.nik || '').trim() === nik);
  if (!match) return null;
  return {
    lark_tanggal_keluar_unit: match.tanggal_keluar_unit || '',
    lark_nomor_plat: match.plat_nomor || '',
    lark_merk_unit: match.merk_unit || '',
    lark_alamat: match.alamat || '',
    lark_tanggal_pengembalian_unit: match.tanggal_pengembalian_unit || '',
    lark_lama_pemakaian: match.lama_pemakaian || '',
    lark_status: match.status || '',
    lark_matched_at: new Date()
  };
};

const processBatch = async (batchIds, driverList, larkData, token, cancellationToken) => {
  if (cancellationToken.isCancelled) return [];
  const results = [];

  for (let i = 0; i < batchIds.length; i += CONCURRENT_REQUESTS) {
    if (cancellationToken.isCancelled) break;
    const chunk = batchIds.slice(i, i + CONCURRENT_REQUESTS);
    const profiles = await Promise.all(
      chunk.map(id => {
        const info = driverList.find(item => String(item.drivers?.id) === String(id));
        return fetchDriverProfile(id, info?.drivers?.user_id, token);
      })
    );

    for (let j = 0; j < chunk.length; j++) {
      const id = chunk[j];
      const profile = profiles[j];
      const info = driverList.find(item => String(item.drivers?.id) === String(id));
      const base = buildBaseProfile(info);

      if (!profile) {
        results.push(base);
        continue;
      }

      const larkMatch = matchLark(profile, larkData);
      const merged = {
        ...base,
        current_lat: profile.current_lat,
        current_lon: profile.current_lon,
        nik: profile.nik,
        sim_number: profile.sim_number,
        sim_expiry: profile.sim_expiry,
        bank_name: profile.bank_name,
        bank_account_holder: profile.bank_account_holder,
        bank_account_number: profile.bank_account_number,
        hub_data: profile.hub_data,
        business_data: profile.business_data,
        hubs: Object.keys(profile.hub_data || {}).length > 0
          ? Object.entries(profile.hub_data).map(([id, name]) => `${name} (${id})`).join(', ')
          : base.hubs,
        businesses: Object.keys(profile.business_data || {}).length > 0
          ? Object.entries(profile.business_data).map(([id, name]) => `${name} (${id})`).join(', ')
          : base.businesses
      };
      if (larkMatch) Object.assign(merged, larkMatch);
      results.push(merged);
    }
  }
  return results;
};

class CancellationToken {
  constructor() { this.cancelled = false; this.reason = null; }
  cancel(reason = 'Cancelled') { if (!this.cancelled) { this.cancelled = true; this.reason = reason; } }
  throwIfCancelled() {
    if (this.cancelled) {
      const e = new Error(this.reason || 'Cancelled'); e.isCancelled = true; throw e;
    }
  }
  get isCancelled() { return this.cancelled; }
}

const activeCancellationTokens = new Map();

const manualSyncMitraExtended = async (syncId, progressCallback) => {
  const startTime = Date.now();
  const ct = new CancellationToken();
  activeCancellationTokens.set(syncId, ct);

  const emit = async (payload) => {
    progressCallback?.(payload);
    await sleep(50);
  };

  try {
    await emit({ stage: 'init', message: 'Initializing...', percentage: 0 });
    ct.throwIfCancelled();

    await emit({ stage: 'auth', message: 'Authenticating with Rideblitz...', percentage: 2 });

    let token;
    try {
      token = await loginToRideblitz();
    } catch (e) {
      throw new Error(`Login failed: ${e.message}`);
    }

    ct.throwIfCancelled();
    await emit({ stage: 'rideblitz_fetch', message: 'Fetching page 1 from Rideblitz...', percentage: 10 });

    let pageData;
    try {
      pageData = await fetchPage1(token);
    } catch (e) {
      if (e.response?.status === 401) {
        invalidateToken();
        token = await loginToRideblitz();
        pageData = await fetchPage1(token);
      } else {
        throw new Error(`Fetch page 1 failed: ${e.message}`);
      }
    }

    ct.throwIfCancelled();

    if (!pageData || !Array.isArray(pageData.driver_list_response) || !pageData.driver_list_response.length) {
      throw new Error('Empty response from Rideblitz page 1.');
    }

    const driverList = pageData.driver_list_response;
    await emit({
      stage: 'rideblitz_fetch',
      message: `Page 1 loaded — ${driverList.length} drivers`,
      percentage: 20
    });

    await emit({ stage: 'lark_fetch', message: 'Fetching Lark data...', percentage: 25 });

    let larkData = [];
    try { larkData = await fetchNikFromLark(); } catch (e) {
      console.warn('[Sync] Lark fetch failed:', e.message);
    }

    ct.throwIfCancelled();
    await emit({ stage: 'validation', message: 'Validating...', percentage: 30 });

    const driverIds = driverList.map(item => item.drivers?.id).filter(Boolean);
    await emit({ stage: 'processing', message: `Processing ${driverIds.length} profiles...`, percentage: 35 });

    const allProfiles = [];

    for (let i = 0; i < driverIds.length; i += BATCH_SIZE) {
      ct.throwIfCancelled();
      const batch = driverIds.slice(i, i + BATCH_SIZE);
      const profiles = await processBatch(batch, driverList, larkData, token, ct);
      allProfiles.push(...profiles);

      const done = Math.min(i + BATCH_SIZE, driverIds.length);
      const pct = 35 + Math.round((done / driverIds.length) * 50);
      await emit({
        stage: 'processing',
        message: `Processed ${done}/${driverIds.length}...`,
        percentage: pct,
        successCount: allProfiles.length
      });
    }

    ct.throwIfCancelled();

    if (!allProfiles.length) throw new Error('No profiles processed.');

    await emit({ stage: 'saving', message: `Saving ${allProfiles.length} records...`, percentage: 88 });

    let successCount = 0;
    const CHUNK = 500;

    for (let i = 0; i < allProfiles.length; i += CHUNK) {
      const chunk = allProfiles.slice(i, i + CHUNK);
      const ops = chunk.map(p => ({
        updateOne: { filter: { driver_id: p.driver_id }, update: { $set: p }, upsert: true }
      }));
      try {
        const res = await MitraExtended.bulkWrite(ops, { ordered: false });
        successCount += res.upsertedCount + res.modifiedCount + res.matchedCount;
      } catch (e) {
        if (e.result) {
          successCount += (e.result.nUpserted || 0) + (e.result.nModified || 0) + (e.result.nMatched || 0);
        }
        console.error('[Sync] bulkWrite error:', e.message);
      }
      const pct = Math.min(88 + Math.round(((i + CHUNK) / allProfiles.length) * 7), 95);
      await emit({ stage: 'saving', message: `Saved ${Math.min(i + CHUNK, allProfiles.length)}/${allProfiles.length}...`, percentage: pct, successCount });
    }

    await emit({ stage: 'finalizing', message: 'Finalizing...', percentage: 97 });

    const summary = {
      driversFromPage1: driverIds.length,
      processedProfiles: allProfiles.length,
      successCount,
      larkMatchCount: allProfiles.filter(p => p.lark_matched_at).length,
      durationSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
      timestamp: new Date().toISOString()
    };

    console.log('[Sync] COMPLETE:', JSON.stringify(summary, null, 2));
    console.log('[Sync] Sample (first 3):', JSON.stringify(allProfiles.slice(0, 3), null, 2));

    await emit({ stage: 'complete', message: `Done: ${successCount} records saved`, percentage: 100 });
    return summary;

  } catch (error) {
    if (error.isCancelled || ct.isCancelled) {
      throw Object.assign(new Error('Sync cancelled'), { isCancelled: true });
    }
    console.error('[Sync] ERROR:', error.message, error.stack);
    throw error;
  } finally {
    activeCancellationTokens.delete(syncId);
  }
};

const cancelSync = (syncId) => {
  const ct = activeCancellationTokens.get(syncId);
  if (ct) { ct.cancel('Cancelled by user'); return true; }
  return false;
};

const cancelAllSyncs = () => {
  let n = 0;
  for (const [, ct] of activeCancellationTokens.entries()) { ct.cancel('All cancelled'); n++; }
  activeCancellationTokens.clear();
  return n;
};

module.exports = { manualSyncMitraExtended, cancelSync, cancelAllSyncs };