const express = require('express');
const router = express.Router();
const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Workbook } = require('exceljs');
const os = require('os');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_MITRA_SECRET || 'pms-mitra-secret-key-2025';

const BLITZ_LOGIN_URL = 'https://driver-api.rideblitz.id/panel/login';
const BLITZ_ORDERS_SEARCH_URL = 'https://adminapis.rideblitz.id/api/v1/orders';
const BLITZ_VALIDATE_BATCH_URL = 'https://bmc.rideblitz.id/v2/validate/batch/orders';
const BLITZ_ADD_BATCH_URL = 'https://bmc.rideblitz.id/v2/add/batch/orders';
const BLITZ_BATCH_DETAILS_URL = 'https://bmc.rideblitz.id/v1/batches/details';
const BLITZ_GENERATE_BATCH_URL = 'https://bmc.rideblitz.id/v1/generate/batch';
const BLITZ_NEARBY_DRIVERS_URL = 'https://driver-api.rideblitz.id/panel/driver';
const BLITZ_ASSIGN_DRIVER_URL = 'https://amc.rideblitz.id/v1/batch/assign/driver';
const BLITZ_DRIVER_LIST_URL = 'https://driver-api.rideblitz.id/v2/panel/driver-list';
const BLITZ_DRIVER_PERFORMANCE_URL = 'https://driver-api.rideblitz.id/v1/panel/driver/performance/batch';
const BLITZ_REMOVE_VALIDATE_URL = 'https://bmc.rideblitz.id/v2/validate/remove/batch/order';
const BLITZ_REMOVE_ORDER_URL = 'https://bmc.rideblitz.id/v2/remove/batch/orders';
const BLITZ_DRIVER_PROFILE_URL = 'https://driver-api.rideblitz.id/panel/driver-profile';
const BLITZ_SAVE_BATCH_URL = 'https://bmc.rideblitz.id/v1/save/batch/orders';

const AUTOMATION_SCRIPT_PATH = path.join(__dirname, '..', 'utils', 'automation.py');
const BLITZ_STATUSES_SKIP_UPLOAD = ['created', 'unbatched', 'batched', 'assigned', 'picked_up', 'in_transit', 'delivered'];

const TOKEN_TTL_MS = 55 * 60 * 1000;
const BULK_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTOMATION_TIMEOUT_MS = 180000;
const BATCH_API_TIMEOUT_MS = 90000;
const BATCH_CHUNK_SIZE = 20;
const UPLOAD_POLL_RETRIES = 3;
const UPLOAD_POLL_INTERVAL_MS = 2500;
const POST_UPLOAD_DELAY_MS = 2000;
const VALIDATE_RETRY_DELAY_MS = 2500;
const MAX_VALIDATE_RETRIES = 2;
const ASSIGN_RETRY_DELAY_MS = 1500;
const ASSIGN_MAX_RETRIES = 3;
const POST_GENERATE_DELAY_MS = 2000;
const GENERATE_ROUTE_POLL_RETRIES = 8;
const GENERATE_ROUTE_POLL_INTERVAL_MS = 2500;

const SEARCH_PAGE_LIMIT = 100;
const SEARCH_MAX_PAGES = 10;
const SEARCH_PAGE_TIMEOUT_MS = 45000;
const SEARCH_GROUP_CONCURRENCY = 2;
const SEARCH_FALLBACK_CONCURRENCY = 1;
const SEARCH_RETRY_COUNT = 3;
const SEARCH_RETRY_DELAY_MS = 4000;
const SEARCH_INTER_REQUEST_DELAY_MS = 600;
const SEARCH_BATCH_DETAILS_CONCURRENCY = 3;
const SEARCH_DAYS_BACK = 60;
const SEARCH_IDS_PER_CHUNK = 50;
const SEARCH_CHUNK_DELAY_MS = 800;

const AUTO_ASSIGN_IN_PROGRESS_CODE = 40002011;
const AUTO_ASSIGN_VERIFY_DELAY_MS = 3000;
const AUTO_ASSIGN_VERIFY_RETRIES = 5;
const AUTO_ASSIGN_VERIFY_INTERVAL_MS = 3000;

const tokenCache = {};
const bulkOrderCache = new Map();
const inFlightByIdMap = new Map();

let activeUpload = null;
let activeProc = null;
let pendingUploads = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const writeInterruptFile = (file) => {
  try { fs.writeFileSync(file, 'interrupt'); } catch {}
};

const cleanupFile = (file) => {
  if (file && fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch {}
  }
};

const getBlitzDateString = (date) => {
  const jakartaOffset = 7 * 60 * 60 * 1000;
  const jd = new Date(date.getTime() + jakartaOffset);
  const datePart = jd.toISOString().split('T')[0];
  const timePart = jd.toISOString().split('T')[1].split('.')[0];
  return `${datePart}+${timePart}`;
};

const getBlitzDateRange = (daysBack = SEARCH_DAYS_BACK) => {
  const now = new Date();
  const jakartaOffset = 7 * 60 * 60 * 1000;
  const jNow = new Date(now.getTime() + jakartaOffset);
  const past = new Date(jNow.getTime() - daysBack * 24 * 60 * 60 * 1000);
  past.setUTCHours(0, 0, 0, 0);
  const pastReal = new Date(past.getTime() - jakartaOffset);
  return { startDate: getBlitzDateString(pastReal), endDate: getBlitzDateString(now) };
};

const PREFIX_MAP = [
  { from: 'INV-', to: 'V-' },
  { from: 'V-', to: 'INV-' },
];

const getAlternativeOrderId = (id) => {
  for (const { from, to } of PREFIX_MAP) {
    if (id.startsWith(from)) return to + id.slice(from.length);
  }
  return null;
};

const getCached = (id) => {
  const entry = bulkOrderCache.get(id);
  if (!entry) return undefined;
  if (!entry.data?.exists) {
    bulkOrderCache.delete(id);
    return undefined;
  }
  if (Date.now() - entry.ts > BULK_CACHE_TTL_MS) {
    bulkOrderCache.delete(id);
    return undefined;
  }
  return entry.data;
};

const setCached = (id, data) => {
  bulkOrderCache.set(id, { data, ts: Date.now() });
};

const getValidationDataByMerchantOrderId = async (project, merchantOrderId) => {
  const order = await mongoose.connection.db
    .collection(`${project}_merchant_orders`)
    .findOne({ merchant_order_id: merchantOrderId });
  if (!order?.sender_name) return null;
  return mongoose.connection.db
    .collection('adminpanel_validations')
    .findOne({ sender_name: order.sender_name });
};

const getCredentialsByDriverId = async (driverId, project) => {
  if (!driverId || !project) return null;
  try {
    const driverData = await mongoose.connection.db
      .collection(`${project}_delivery`)
      .findOne({ driver_id: driverId.toString() });
    if (!driverData?.user_id) return null;
    const credential = await mongoose.connection.db
      .collection('blitz_logins')
      .findOne({ user_id: driverData.user_id, status: 'active' });
    return credential ? { username: credential.username, password: credential.password, role: driverData.role || null } : null;
  } catch {
    return null;
  }
};

const getBlitzCredentials = async (req) => {
  if (req?.body?._blitz_un && req?.body?._blitz_pw)
    return { username: req.body._blitz_un, password: req.body._blitz_pw, role: null };
  if (req?.query?._blitz_un && req?.query?._blitz_pw)
    return { username: req.query._blitz_un, password: req.query._blitz_pw, role: null };
  if (req?.headers?.authorization?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(req.headers.authorization.substring(7), JWT_SECRET);
      if (decoded.blitz_username && decoded.blitz_password)
        return { username: decoded.blitz_username, password: decoded.blitz_password, role: decoded.role || null };
      if (decoded.user_id) {
        const driverData = decoded.project
          ? await mongoose.connection.db.collection(`${decoded.project}_delivery`).findOne({ driver_id: decoded.driver_id?.toString() })
          : null;
        const credential = await mongoose.connection.db
          .collection('blitz_logins')
          .findOne({ user_id: decoded.user_id, status: 'active' });
        if (credential) return { username: credential.username, password: credential.password, role: driverData?.role || null };
      }
    } catch {}
  }
  if (req?.body?.driverId && (req?.body?.project || req?.query?.project)) {
    const cred = await getCredentialsByDriverId(
      req.body.driverId,
      req.body.project || req.query.project
    );
    if (cred) return cred;
  }
  const credential = await mongoose.connection.db
    .collection('blitz_logins')
    .findOne({ status: 'active' });
  if (!credential) throw new Error('No active Blitz credentials found in database');
  return { username: credential.username, password: credential.password, role: null };
};

const loginToBlitz = async (username, password) => {
  const response = await axios.post(
    BLITZ_LOGIN_URL,
    { username, password },
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 30000 }
  );
  if (response.data.result) return response.data.data.access_token;
  throw new Error('Login failed: ' + (response.data.message || 'Unknown error'));
};

const getAccessToken = async (req) => {
  const credentials = await getBlitzCredentials(req);
  const cacheKey = credentials.username;
  if (tokenCache[cacheKey]?.expiry && Date.now() < tokenCache[cacheKey].expiry)
    return tokenCache[cacheKey].token;
  const token = await loginToBlitz(credentials.username, credentials.password);
  tokenCache[cacheKey] = { token, expiry: Date.now() + TOKEN_TTL_MS };
  return token;
};

const formatDriverContact = (mobile) => {
  if (!mobile) return null;
  const cleaned = mobile.toString().replace(/\D/g, '');
  if (cleaned.startsWith('62')) return `+${cleaned}`;
  if (cleaned.startsWith('0')) return `+62${cleaned.slice(1)}`;
  return `+62${cleaned}`;
};

const fetchBatchDetails = async (batchId, accessToken) => {
  try {
    const response = await axios.get(`${BLITZ_BATCH_DETAILS_URL}/${batchId}`, {
      headers: { Accept: 'application/json', Authorization: accessToken, bt: '2' },
      timeout: 20000,
    });
    if (response.data.result && response.data.data) {
      const d = response.data.data;
      const driver = d.driver || {};
      const batchStatus = d.batch_status || {};
      const routing = Array.isArray(d.routing) ? d.routing : [];

      const pickupNode = routing.find((n) => n.node_type?.id === 1);
      const pickupCoordinate = pickupNode?.coordinate || null;

      const awbMap = {};
      routing.forEach((node) => {
        if (Array.isArray(node.batch_node_orders)) {
          node.batch_node_orders.forEach((o) => {
            if (o.merchant_order_id && o.awb_number) {
              awbMap[o.merchant_order_id] = o.awb_number;
            }
          });
        }
      });

      const dropoffNodes = routing
        .filter((n) => n.node_type?.id === 2)
        .sort((a, b) => a.sequence - b.sequence);

      const routeSequence = dropoffNodes.map((node) => {
        const orders = Array.isArray(node.batch_node_orders) ? node.batch_node_orders : [];
        return {
          sequence: node.sequence,
          pic_name: node.pic_name || null,
          pic_contact: node.pic_contact || null,
          address: node.address || null,
          coordinate: node.coordinate || null,
          batch_node_status: node.batch_node_status?.name || null,
          orders: orders.map((o) => ({
            merchant_order_id: o.merchant_order_id,
            awb_number: o.awb_number || null,
            is_completed: o.is_completed || false,
          })),
        };
      });

      return {
        driver_name: driver.name ? driver.name.trim() : null,
        driver_contact: formatDriverContact(driver.mobile),
        batch_status: batchStatus.name || null,
        awb_map: awbMap,
        route_sequence: routeSequence,
        pickup_coordinate: pickupCoordinate,
        routing_count: routing.length,
        driver_id: driver.id || null,
        assignment_id: d.assignment?.id || null,
      };
    }
    return null;
  } catch {
    return null;
  }
};

const isBatchRouteReady = async (batchId, accessToken) => {
  const details = await fetchBatchDetails(batchId, accessToken);
  if (!details) return false;
  return details.routing_count > 0 && details.route_sequence && details.route_sequence.length > 0;
};

const waitForRouteGeneration = async (batchId, accessToken) => {
  for (let attempt = 1; attempt <= GENERATE_ROUTE_POLL_RETRIES; attempt++) {
    await sleep(GENERATE_ROUTE_POLL_INTERVAL_MS);
    const ready = await isBatchRouteReady(batchId, accessToken);
    if (ready) return true;
  }
  return false;
};

const verifyAssignmentInBatch = async (batchId, driverId, accessToken) => {
  for (let attempt = 1; attempt <= AUTO_ASSIGN_VERIFY_RETRIES; attempt++) {
    await sleep(AUTO_ASSIGN_VERIFY_INTERVAL_MS);
    try {
      const details = await fetchBatchDetails(batchId, accessToken);
      if (details && details.driver_id && parseInt(details.driver_id) === parseInt(driverId)) {
        return { assigned: true, assignmentId: details.assignment_id };
      }
    } catch {}
  }
  return { assigned: false, assignmentId: null };
};

const normalizeId = (id) => (id || '').trim().toLowerCase();

const runWithConcurrency = async (tasks, concurrency) => {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (task) await task().catch(() => {});
    }
  });
  await Promise.allSettled(workers);
};

const buildBlitzSearchUrl = (q, startDate, endDate, page = 1) => {
  const parts = [
    `sort=created_at`, `dir=-1`, `page=${page}`,
    `start_date=${startDate}`, `end_date=${endDate}`,
    `q=${encodeURIComponent(q)}`,
    `limit=${SEARCH_PAGE_LIMIT}`,
    `pickup_schedule_type=standard,scheduled,immediate`,
    `pickup_sla_model=pickup_slots,operational_hours`,
  ];
  return `${BLITZ_ORDERS_SEARCH_URL}?${parts.join('&')}`;
};

const fetchPageWithRetry = async (url, accessToken) => {
  let attempt = 0;
  while (true) {
    try {
      const response = await axios.get(url, {
        headers: { Accept: 'application/json', Authorization: accessToken },
        timeout: SEARCH_PAGE_TIMEOUT_MS,
      });
      const results = Array.isArray(response.data?.results)
        ? response.data.results
        : Array.isArray(response.data?.data)
          ? response.data.data
          : [];
      const total = response.data?.total ?? response.data?.count ?? results.length;
      return { results, total };
    } catch (err) {
      attempt++;
      if (attempt > SEARCH_RETRY_COUNT) return { results: [], total: 0 };
      await sleep(SEARCH_RETRY_DELAY_MS * attempt);
    }
  }
};

const groupIdsByPrefix = (ids) => {
  const groups = new Map();
  for (const id of ids) {
    const parts = id.split('-');
    const key = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  return groups;
};

const matchResultsToIdSet = (results, targetIds) => {
  const normLookup = new Map();
  for (const id of targetIds) {
    normLookup.set(normalizeId(id), id);
    const alt = getAlternativeOrderId(id);
    if (alt) normLookup.set(normalizeId(alt), id);
  }
  const matched = {};
  for (const r of results) {
    const norm = normalizeId(r.merchant_order_id);
    if (normLookup.has(norm)) {
      const origId = normLookup.get(norm);
      if (!matched[origId] || (r.created_at || 0) > (matched[origId].created_at || 0)) {
        matched[origId] = r;
      }
    }
  }
  return matched;
};

const fetchAllPagesForQuery = async (query, accessToken) => {
  const { startDate, endDate } = getBlitzDateRange();
  const allResults = [];

  const firstUrl = buildBlitzSearchUrl(query, startDate, endDate, 1);
  const { results: page1, total } = await fetchPageWithRetry(firstUrl, accessToken);
  allResults.push(...page1);

  if (total > SEARCH_PAGE_LIMIT) {
    const totalPages = Math.min(Math.ceil(total / SEARCH_PAGE_LIMIT), SEARCH_MAX_PAGES);
    for (let page = 2; page <= totalPages; page++) {
      await sleep(SEARCH_INTER_REQUEST_DELAY_MS);
      const url = buildBlitzSearchUrl(query, startDate, endDate, page);
      const { results } = await fetchPageWithRetry(url, accessToken);
      allResults.push(...results);
      if (results.length === 0) break;
    }
  }

  return allResults;
};

const searchChunkCore = async (chunkIds, accessToken) => {
  const rawMap = {};
  for (const id of chunkIds) rawMap[id] = null;

  const prefixGroups = groupIdsByPrefix(chunkIds);
  const groupTasks = Array.from(prefixGroups.entries()).map(([prefix, groupIds]) => async () => {
    const results = await fetchAllPagesForQuery(prefix, accessToken);
    const matched = matchResultsToIdSet(results, groupIds);
    for (const [id, row] of Object.entries(matched)) rawMap[id] = row;
    await sleep(SEARCH_INTER_REQUEST_DELAY_MS);
  });
  await runWithConcurrency(groupTasks, SEARCH_GROUP_CONCURRENCY);

  const stillMissing = chunkIds.filter(id => !rawMap[id]);
  if (stillMissing.length > 0) {
    const fallbackTasks = stillMissing.map((id, idx) => async () => {
      if (idx > 0) await sleep(SEARCH_INTER_REQUEST_DELAY_MS * 2);
      const results = await fetchAllPagesForQuery(id, accessToken);
      const matched = matchResultsToIdSet(results, [id]);
      if (matched[id]) rawMap[id] = matched[id];
    });
    await runWithConcurrency(fallbackTasks, SEARCH_FALLBACK_CONCURRENCY);
  }

  return rawMap;
};

const enrichChunkWithBatchDetails = async (rawMap, accessToken) => {
  const batchIdsNeeded = new Set();
  for (const r of Object.values(rawMap)) {
    if (r?.batch_id && r.batch_id > 0) batchIdsNeeded.add(r.batch_id);
  }

  const batchDetailsMap = {};
  const batchTasks = Array.from(batchIdsNeeded).map(batchId => async () => {
    const details = await fetchBatchDetails(batchId, accessToken);
    if (details) batchDetailsMap[batchId] = details;
  });
  await runWithConcurrency(batchTasks, SEARCH_BATCH_DETAILS_CONCURRENCY);

  const enriched = {};
  for (const [id, r] of Object.entries(rawMap)) {
    if (!r) {
      enriched[id] = { exists: false };
      continue;
    }
    const details = r.batch_id ? batchDetailsMap[r.batch_id] : null;
    const awbFromRoute = details?.awb_map?.[id] || details?.awb_map?.[r.merchant_order_id] || null;
    const entry = {
      exists: true,
      order_status: r.order_status || null,
      batch_id: r.batch_id || null,
      blitz_merchant_order_id: r.merchant_order_id,
      awb_number: awbFromRoute || r.awb_number || null,
      driver_name: details?.driver_name || null,
      driver_contact: details?.driver_contact || null,
      batch_status: details?.batch_status || null,
      route_sequence: details?.route_sequence || null,
      pickup_coordinate: details?.pickup_coordinate || null,
    };
    setCached(id, entry);
    enriched[id] = entry;
  }
  return enriched;
};

const searchBlitzOrdersBulk = async (merchantOrderIds, accessToken) => {
  if (!merchantOrderIds || merchantOrderIds.length === 0) return {};

  const result = {};
  const uncachedIds = [];

  for (const id of merchantOrderIds) {
    const cached = getCached(id);
    if (cached !== undefined) {
      result[id] = cached;
    } else {
      uncachedIds.push(id);
    }
  }

  if (uncachedIds.length === 0) return result;

  const idsToFetch = [];
  const waitPromises = [];

  for (const id of uncachedIds) {
    if (inFlightByIdMap.has(id)) {
      waitPromises.push({ id, promise: inFlightByIdMap.get(id) });
    } else {
      idsToFetch.push(id);
    }
  }

  for (const { id, promise } of waitPromises) {
    try {
      const val = await promise;
      result[id] = val ?? { exists: false };
    } catch {
      result[id] = { exists: false };
    }
  }

  if (idsToFetch.length === 0) return result;

  const chunks = [];
  for (let i = 0; i < idsToFetch.length; i += SEARCH_IDS_PER_CHUNK) {
    chunks.push(idsToFetch.slice(i, i + SEARCH_IDS_PER_CHUNK));
  }

  const perIdResolvers = {};
  const perIdPromises = {};

  for (const id of idsToFetch) {
    const p = new Promise((resolve) => { perIdResolvers[id] = resolve; });
    perIdPromises[id] = p;
    inFlightByIdMap.set(id, p);
  }

  (async () => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const rawMap = await searchChunkCore(chunk, accessToken);
        const enriched = await enrichChunkWithBatchDetails(rawMap, accessToken);
        for (const id of chunk) {
          const val = enriched[id] ?? { exists: false };
          if (!val.exists) setCached(id, val);
          perIdResolvers[id](val);
          inFlightByIdMap.delete(id);
        }
      } catch {
        for (const id of chunk) {
          const fallback = { exists: false };
          perIdResolvers[id](fallback);
          inFlightByIdMap.delete(id);
        }
      }
      if (i < chunks.length - 1) {
        await sleep(SEARCH_CHUNK_DELAY_MS);
      }
    }
  })();

  for (const id of idsToFetch) {
    try {
      result[id] = await perIdPromises[id];
    } catch {
      result[id] = { exists: false };
    }
  }

  return result;
};

const extractBlitzErrorMessage = (errorData) =>
  errorData?.error?.message || errorData?.message || null;

const extractOrdersArray = (responseData) => {
  if (!responseData) return [];
  if (Array.isArray(responseData.data)) return responseData.data;
  if (Array.isArray(responseData.blitz_error?.data)) return responseData.blitz_error.data;
  if (Array.isArray(responseData.blitz_error?.blitz_error?.data))
    return responseData.blitz_error.blitz_error.data;
  return [];
};

const extractValidationErrors = (responseData) => {
  return extractOrdersArray(responseData)
    .filter((o) => o.validation?.is_valid === false)
    .map((o) => {
      const reason = o.validation.reason?.trim();
      const message = o.validation.message?.trim();
      const validationMessage = (reason && reason !== 'Invalid order')
        ? reason
        : (message && message !== 'Invalid order')
          ? message
          : 'Invalid order';
      return {
        merchant_order_id: o.merchant_order_id,
        awb_number: o.awb_number || '',
        validation_message: validationMessage,
        delivery_attempt_number: o.delivery_attempt || 0,
        package_weight: o.weight ? String(o.weight) + ' kg' : '',
        dropoff_address: o.dropoff?.address || '',
        dropoff_city: o.dropoff?.city || '',
        dropoff_district: o.dropoff?.district || '',
        dropoff_postal_code: o.dropoff?.postal_code || '',
      };
    });
};

const hasInvalidOrders = (data) =>
  extractOrdersArray(data).some((o) => o.validation?.is_valid === false);

const INVALID_COORD_KEYWORDS = ['invalid coordinate', 'invalid coord', 'invalid dropoff coordinate', 'koordinat', 'outside', 'out of range', 'diluar', 'cannot generate', 'dropoff coordinate'];

const isCoordInvalidError = (message) => {
  if (!message) return false;
  const lower = message.toLowerCase();
  return INVALID_COORD_KEYWORDS.some(k => lower.includes(k));
};

const detectCoordErrorInValidation = (validationErrors, rawResponseData) => {
  if (rawResponseData) {
    const rawOrders = Array.isArray(rawResponseData.data) ? rawResponseData.data : [];
    const hasCoordError = rawOrders.some(o =>
      o.validation?.is_valid === false && isCoordInvalidError(o.validation?.reason)
    );
    if (hasCoordError) return true;
  }
  if (!Array.isArray(validationErrors) || validationErrors.length === 0) return false;
  return validationErrors.some(e =>
    isCoordInvalidError(e.validation_message) || isCoordInvalidError(e.reason)
  );
};

const buildCoordErrorBody = (message, blitzError, validationErrors) => ({
  success: false,
  message: message || 'Koordinat order tidak valid — generate route akan gagal.',
  errorCode: 40002,
  blitz_generate_error: true,
  blitz_error: blitzError,
  validation_errors: validationErrors,
});

const isAutoAssignInProgressError = (errorCode, message) => {
  if (errorCode === AUTO_ASSIGN_IN_PROGRESS_CODE) return true;
  const msg = (message || '').toLowerCase();
  return msg.includes('auto assignment in progress') || msg.includes('assignment in progress');
};

const createExcelFromOrders = async (orders) => {
  const workbook = new Workbook();
  const ws = workbook.addWorksheet('Sheet1');
  const headers = [
    'merchant_order_id*', 'weight*', 'width', 'height', 'length',
    'payment_type*', 'cod_amount', 'sender_name*', 'sender_phone*',
    'pickup_instructions', 'consignee_name*', 'consignee_phone*',
    'destination_district', 'destination_city*', 'destination_province',
    'destination_postalcode*', 'destination_address*', 'dropoff_lat',
    'dropoff_long', 'dropoff_instructions', 'item_value*', 'product_details*',
  ];
  ws.addRow(headers);
  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (const o of orders) {
    ws.addRow([
      o.merchant_order_id || '', o.weight || 0, o.width || 0, o.height || 0, o.length || 0,
      o.payment_type || 'non_cod', o.cod_amount || 0, o.sender_name || '', o.sender_phone || '',
      o.pickup_instructions || '', o.consignee_name || '', o.consignee_phone || '',
      o.destination_district || '', o.destination_city || '', o.destination_province || '',
      o.destination_postalcode || '', o.destination_address || '', o.dropoff_lat || 0,
      o.dropoff_long || 0, o.dropoff_instructions || '', o.item_value || 0, o.product_details || '',
    ]);
  }
  const tempFile = path.join(
    os.tmpdir(),
    `blitz_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.xlsx`
  );
  await workbook.xlsx.writeFile(tempFile);
  return tempFile;
};

const dedupeOrders = (orders) => {
  const seen = new Set();
  return orders.filter((o) => {
    if (seen.has(o.merchant_order_id)) return false;
    seen.add(o.merchant_order_id);
    return true;
  });
};

class AdminPanelValidationError extends Error {
  constructor(errors) {
    super('AdminPanel validation error');
    this.name = 'AdminPanelValidationError';
    this.adminpanel_errors = errors;
  }
}

const drainUploadQueue = () => {
  if (pendingUploads.length === 0 || activeUpload) return;
  const next = pendingUploads.shift();
  const toMerge = [next];
  const remaining = [];
  for (const p of pendingUploads) {
    const sameConfig =
      p.hubId === next.hubId && p.business === next.business &&
      p.city === next.city && p.serviceType === next.serviceType;
    if (sameConfig) toMerge.push(p);
    else remaining.push(p);
  }
  pendingUploads = remaining;
  if (toMerge.length === 1) {
    startUpload(next);
    return;
  }
  const mergedOrders = dedupeOrders(toMerge.flatMap((u) => u.orders));
  const allResolvers = toMerge.map((u) => ({ resolve: u.resolve, reject: u.reject }));
  startUpload({
    orders: mergedOrders,
    hubId: next.hubId, business: next.business, city: next.city, serviceType: next.serviceType,
    username: next.username, password: next.password, role: next.role,
    resolve: (r) => allResolvers.forEach((ar) => ar.resolve(r)),
    reject: (e) => allResolvers.forEach((ar) => ar.reject(e)),
  });
};

const startUpload = async (upload) => {
  const { orders, hubId, business, city, serviceType, username, password, role, resolve, reject } = upload;
  let excelFile;
  try {
    excelFile = await createExcelFromOrders(orders);
  } catch (e) {
    activeUpload = null;
    activeProc = null;
    reject(e);
    drainUploadQueue();
    return;
  }

  const tempInstanceId = `pending_${Date.now()}`;
  activeUpload = {
    instanceId: tempInstanceId,
    interruptFile: `/tmp/blitz_interrupt_${tempInstanceId}`,
    orders, hubId, business, city, serviceType, username, password, role,
    passedCheckpoint: false, resolve, reject,
  };

  if (!fs.existsSync(AUTOMATION_SCRIPT_PATH)) {
    activeUpload = null;
    activeProc = null;
    reject(new Error(`automation.py not found at: ${AUTOMATION_SCRIPT_PATH}`));
    drainUploadQueue();
    return;
  }

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let timeoutHandle;

  const proc = spawn('python3', [AUTOMATION_SCRIPT_PATH], {
    env: {
      ...process.env,
      BLITZ_USERNAME: username,
      BLITZ_PASSWORD: password,
      BLITZ_FILE_PATH: excelFile,
      BLITZ_BUSINESS_HUB: hubId.toString(),
      BLITZ_BUSINESS: business.toString(),
      BLITZ_CITY: city.toString(),
      BLITZ_SERVICE_TYPE: serviceType.toString(),
      BLITZ_AUTO_SUBMIT: 'true',
      BLITZ_GOOGLE_SHEET_URL: '',
      BLITZ_KEEP_FILE: 'false',
      BLITZ_DRIVER_ROLE: role || '',
    },
  });

  activeProc = proc;

  timeoutHandle = setTimeout(() => {
    try { proc.kill('SIGTERM'); } catch {}
    activeProc = null;
    activeUpload = null;
    reject(new Error(`Automation timeout after ${AUTOMATION_TIMEOUT_MS / 1000}s`));
    drainUploadQueue();
  }, AUTOMATION_TIMEOUT_MS);

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutBuffer += text;
    text.split('\n').forEach((line) => {
      line = line.trim();
      if (!line || !activeUpload) return;
      const instanceMatch = line.match(/\[(?:DEBUG|CHECKPOINT|INTERRUPTED)\]\[([^\]]+)\]\[([a-f0-9]{8})\]/);
      if (instanceMatch) {
        const realId = instanceMatch[2];
        if (activeUpload.instanceId !== realId) {
          activeUpload.instanceId = realId;
          activeUpload.interruptFile = `/tmp/blitz_interrupt_${realId}`;
        }
      }
      if (line.includes('[CHECKPOINT][SAVE_CLICKED]')) activeUpload.passedCheckpoint = true;
    });
  });

  proc.stderr.on('data', (chunk) => { stderrBuffer += chunk.toString(); });

  proc.on('close', (code) => {
    if (activeProc !== proc) { cleanupFile(excelFile); return; }
    clearTimeout(timeoutHandle);
    cleanupFile(excelFile);
    activeProc = null;
    const finishedUpload = activeUpload;
    activeUpload = null;
    if (!finishedUpload) { drainUploadQueue(); return; }

    if (code === 0) {
      finishedUpload.resolve({ success: true });
    } else if (code === 2) {
      console.log('[upload-queue] Upload interrupted cleanly (exit 2)');
    } else if (code === 3) {
      try {
        const parsed = JSON.parse(stderrBuffer.trim());
        if (parsed.validation_error && Array.isArray(parsed.errors)) {
          finishedUpload.reject(new AdminPanelValidationError(parsed.errors));
        } else {
          finishedUpload.reject(new AdminPanelValidationError([{ validation_message: stderrBuffer || 'AdminPanel validation error', merchant_order_id: null }]));
        }
      } catch {
        finishedUpload.reject(new AdminPanelValidationError([{ validation_message: stderrBuffer || 'AdminPanel validation error', merchant_order_id: null }]));
      }
    } else {
      finishedUpload.reject(new Error(`Automation failed (exit ${code}): ${stderrBuffer || 'Unknown error'}`));
    }
    drainUploadQueue();
  });

  proc.on('error', (e) => {
    if (activeProc !== proc) return;
    clearTimeout(timeoutHandle);
    cleanupFile(excelFile);
    activeProc = null;
    const finishedUpload = activeUpload;
    activeUpload = null;
    if (finishedUpload) finishedUpload.reject(new Error(`Failed to start automation: ${e.message}`));
    drainUploadQueue();
  });
};

const smartUpload = (orders, hubId, business, city, serviceType, username, password, role) => {
  return new Promise((resolve, reject) => {
    if (!activeUpload) {
      startUpload({ orders, hubId, business, city, serviceType, username, password, role, resolve, reject });
      return;
    }
    if (!activeUpload.passedCheckpoint) {
      const mergedOrders = dedupeOrders([...activeUpload.orders, ...orders]);
      const mergedHubId = activeUpload.hubId;
      const mergedBusiness = activeUpload.business;
      const mergedCity = activeUpload.city;
      const mergedServiceType = activeUpload.serviceType;
      const mergedRole = activeUpload.role;
      const allResolvers = [
        { resolve: activeUpload.resolve, reject: activeUpload.reject },
        { resolve, reject },
        ...pendingUploads.map((p) => ({ resolve: p.resolve, reject: p.reject })),
      ];
      pendingUploads = [];
      writeInterruptFile(activeUpload.interruptFile);
      if (activeProc) {
        try { activeProc.kill('SIGTERM'); } catch {}
        activeProc = null;
      }
      activeUpload = null;
      startUpload({
        orders: mergedOrders, hubId: mergedHubId, business: mergedBusiness,
        city: mergedCity, serviceType: mergedServiceType, username, password, role: mergedRole,
        resolve: (r) => allResolvers.forEach((ar) => ar.resolve(r)),
        reject: (e) => allResolvers.forEach((ar) => ar.reject(e)),
      });
    } else {
      pendingUploads.push({ orders, hubId, business, city, serviceType, username, password, role, resolve, reject });
    }
  });
};

const classifyOrdersByBlitzStatus = async (orders, accessToken) => {
  const ids = orders.map((o) => o.merchant_order_id);
  const searchResults = await searchBlitzOrdersBulk(ids, accessToken);

  const needUpload = [];
  const skipUpload = [];
  orders.forEach((o) => {
    const r = searchResults[o.merchant_order_id];
    if (r?.exists && BLITZ_STATUSES_SKIP_UPLOAD.includes(r.order_status?.toLowerCase()))
      skipUpload.push(o);
    else needUpload.push(o);
  });
  return { needUpload, skipUpload };
};

const waitUntilOrdersAppearInBlitz = async (
  ids,
  accessToken,
  maxRetries = UPLOAD_POLL_RETRIES,
  intervalMs = UPLOAD_POLL_INTERVAL_MS
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    ids.forEach((id) => bulkOrderCache.delete(id));
    const searchResults = await searchBlitzOrdersBulk(ids, accessToken);
    const missing = ids.filter((id) => !searchResults[id]?.exists);
    if (missing.length === 0) return { success: true, missing: [] };
    if (attempt < maxRetries) await sleep(intervalMs);
  }
  return { success: false, missing: [] };
};

const validateBatchChunked = async (accessToken, merchantOrderIds, batchId, hubId) => {
  const chunks = [];
  for (let i = 0; i < merchantOrderIds.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(merchantOrderIds.slice(i, i + BATCH_CHUNK_SIZE));
  }

  let allValidationErrors = [];

  const chunkResults = await Promise.all(chunks.map(async (chunk) => {
    try {
      const validateResponse = await axios.post(
        BLITZ_VALIDATE_BATCH_URL,
        { batchId: parseInt(batchId) || 0, hub_id: hubId, sequence_type: 1, merchant_order_ids: chunk },
        {
          headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' },
          timeout: BATCH_API_TIMEOUT_MS,
        }
      );
      return { ok: true, data: validateResponse.data };
    } catch (e) {
      const d = e.response?.data;
      return { ok: false, message: extractBlitzErrorMessage(d) || e.message, blitz_error: d, validation_errors: extractValidationErrors(d) };
    }
  }));

  for (const r of chunkResults) {
    if (!r.ok) {
      return { success: false, message: r.message, blitz_error: r.blitz_error, validation_errors: r.validation_errors };
    }
    if (!r.data.result) {
      return {
        success: false,
        message: extractBlitzErrorMessage(r.data) || 'Validation failed',
        blitz_error: r.data,
        validation_errors: extractValidationErrors(r.data),
      };
    }
    if (hasInvalidOrders(r.data)) {
      const validationErrors = extractValidationErrors(r.data);
      const isCoordError = detectCoordErrorInValidation(validationErrors, r.data);
      const errMsg = isCoordError
        ? 'Koordinat order tidak valid — generate route akan gagal. Periksa kolom dropoff_lat / dropoff_long.'
        : 'Please remove invalid orders before creating the batch.';
      return isCoordError
        ? buildCoordErrorBody(errMsg, r.data, validationErrors)
        : {
            success: false,
            message: errMsg,
            blitz_error: r.data,
            validation_errors: validationErrors,
          };
    }
    allValidationErrors = allValidationErrors.concat(extractValidationErrors(r.data));
  }

  return { success: true, validation_errors: allValidationErrors };
};

const addToBatchChunked = async (accessToken, merchantOrderIds, batchId, hubId) => {
  const chunks = [];
  for (let i = 0; i < merchantOrderIds.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(merchantOrderIds.slice(i, i + BATCH_CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(chunks.map(async (chunk) => {
    try {
      const addResponse = await axios.post(
        BLITZ_ADD_BATCH_URL,
        { sequence_type: 1, batch_id: parseInt(batchId), merchant_order_ids: chunk, hub_id: hubId },
        {
          headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' },
          timeout: BATCH_API_TIMEOUT_MS,
        }
      );
      return { ok: true, data: addResponse.data };
    } catch (e) {
      const d = e.response?.data;
      return { ok: false, message: `Failed to add to batch: ${extractBlitzErrorMessage(d) || e.message}`, blitz_error: d, validation_errors: extractValidationErrors(d) };
    }
  }));

  for (const r of chunkResults) {
    if (!r.ok) {
      return { success: false, message: r.message, blitz_error: r.blitz_error, validation_errors: r.validation_errors };
    }
    if (!r.data.result) {
      return {
        success: false,
        message: extractBlitzErrorMessage(r.data) || 'Add to batch failed',
        blitz_error: r.data,
        validation_errors: extractValidationErrors(r.data),
      };
    }
  }

  return { success: true };
};

const JAKARTA_BOUNDS = {
  latMin: -6.5,
  latMax: -5.9,
  lonMin: 106.6,
  lonMax: 107.1,
};

const isCoordinateValid = (lat, lon) => {
  if (!lat || !lon || lat === 0 || lon === 0) return false;
  return (
    lat >= JAKARTA_BOUNDS.latMin && lat <= JAKARTA_BOUNDS.latMax &&
    lon >= JAKARTA_BOUNDS.lonMin && lon <= JAKARTA_BOUNDS.lonMax
  );
};

const parseInvalidNodeFromError = (errorMessage) => {
  if (!errorMessage) return null;
  const nodeMatch = errorMessage.match(/Node:\s*(\d+)/);
  const coordMatch = errorMessage.match(/Coordinate:\s*([\d.-]+),([\d.-]+)/);
  if (!nodeMatch && !coordMatch) return null;
  return {
    nodeId: nodeMatch ? parseInt(nodeMatch[1]) : null,
    lat: coordMatch ? parseFloat(coordMatch[1]) : null,
    lon: coordMatch ? parseFloat(coordMatch[2]) : null,
  };
};

const getNodesInBatch = async (batchId, accessToken) => {
  try {
    const response = await axios.get(`${BLITZ_BATCH_DETAILS_URL}/${batchId}`, {
      headers: { Accept: 'application/json', Authorization: accessToken, bt: '2' },
      timeout: 30000,
    });
    if (!response.data.result || !response.data.data) return [];
    const routing = Array.isArray(response.data.data.routing) ? response.data.data.routing : [];
    return routing.map(node => ({
      node_id: node.id ?? node.node_id ?? null,
      node_type: node.node_type?.id ?? null,
      coordinate: node.coordinate || null,
      orders: Array.isArray(node.batch_node_orders)
        ? node.batch_node_orders.map(o => o.merchant_order_id).filter(Boolean)
        : [],
    }));
  } catch {
    return [];
  }
};

const removeInvalidOrdersFromBatch = async (batchId, invalidNode, accessToken) => {
  const nodes = await getNodesInBatch(batchId, accessToken);

  const badNodes = nodes.filter(node => {
    if (invalidNode.nodeId != null && node.node_id != null && node.node_id === invalidNode.nodeId) return true;
    if (node.coordinate) {
      const lat = node.coordinate.latitude ?? node.coordinate.lat;
      const lon = node.coordinate.longitude ?? node.coordinate.lon ?? node.coordinate.lng;
      if (lat != null && lon != null) {
        if (invalidNode.lat != null && invalidNode.lon != null) {
          if (Math.abs(lat - invalidNode.lat) < 0.001 && Math.abs(lon - invalidNode.lon) < 0.001) return true;
        }
        if (!isCoordinateValid(lat, lon)) return true;
      }
    }
    return false;
  });

  const merchantOrderIds = [...new Set(badNodes.flatMap(n => n.orders))];

  if (merchantOrderIds.length === 0) {
    const allInvalidCoordNodes = nodes.filter(node => {
      if (node.node_type === 1) return false;
      if (!node.coordinate) return false;
      const lat = node.coordinate.latitude ?? node.coordinate.lat;
      const lon = node.coordinate.longitude ?? node.coordinate.lon ?? node.coordinate.lng;
      return lat != null && lon != null && !isCoordinateValid(lat, lon);
    });

    const fallbackIds = [...new Set(allInvalidCoordNodes.flatMap(n => n.orders))];

    if (fallbackIds.length > 0) {
      for (const merchantOrderId of fallbackIds) {
        try {
          await axios.post(`${BLITZ_REMOVE_VALIDATE_URL}/${batchId}`, { merchant_order_id: merchantOrderId }, {
            headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' },
            timeout: 30000,
          });
        } catch {}
        await sleep(300);
        try {
          await axios.post(BLITZ_REMOVE_ORDER_URL, { sequence_type: 1, batch_id: parseInt(batchId), merchant_order_ids: [merchantOrderId], hub_id: 0 }, {
            headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' },
            timeout: 30000,
          });
        } catch {}
        await sleep(500);
      }
      return { removed: fallbackIds.length, merchantOrderIds: fallbackIds, badNodeIds: allInvalidCoordNodes.map(n => n.node_id) };
    }

    return { removed: 0, merchantOrderIds: [], badNodeIds: badNodes.map(n => n.node_id) };
  }

  for (const merchantOrderId of merchantOrderIds) {
    try {
      await axios.post(`${BLITZ_REMOVE_VALIDATE_URL}/${batchId}`, { merchant_order_id: merchantOrderId }, {
        headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' },
        timeout: 30000,
      });
    } catch {}
    await sleep(300);
    try {
      await axios.post(BLITZ_REMOVE_ORDER_URL, { sequence_type: 1, batch_id: parseInt(batchId), merchant_order_ids: [merchantOrderId], hub_id: 0 }, {
        headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' },
        timeout: 30000,
      });
    } catch {}
    await sleep(500);
  }

  return { removed: merchantOrderIds.length, merchantOrderIds, badNodeIds: badNodes.map(n => n.node_id) };
};

const generateAndWaitForRoute = async (batchId, accessToken, removedOrders = [], attempt = 0) => {
  if (attempt > 5) {
    return { ready: false, error: null };
  }

  let generateSuccess = false;
  let generateErrorMessage = null;
  let generateErrorCode = null;
  let generateErrorRaw = null;

  try {
    const res = await axios.get(`${BLITZ_GENERATE_BATCH_URL}/${batchId}`, {
      headers: { Accept: 'application/json', Authorization: accessToken, bt: '2' },
      timeout: 30000,
    });
    if (res.data.result) {
      generateSuccess = true;
    } else {
      generateErrorMessage = res.data?.error?.message || res.data?.message;
      generateErrorCode = res.data?.error?.code || null;
      generateErrorRaw = res.data;
    }
  } catch (e) {
    const status = e.response?.status;
    const errBody = e.response?.data;
    if (status === 424) {
      generateSuccess = true;
    } else {
      generateErrorMessage = errBody?.error?.message || errBody?.message || e.message;
      generateErrorCode = errBody?.error?.code || null;
      generateErrorRaw = errBody;
    }
  }

  if (!generateSuccess && generateErrorMessage) {
    const invalidNode = parseInvalidNodeFromError(generateErrorMessage);
    if (invalidNode && (invalidNode.nodeId != null || invalidNode.lat != null)) {
      const removeResult = await removeInvalidOrdersFromBatch(batchId, invalidNode, accessToken);

      if (removeResult.removed > 0) {
        await sleep(2000);
        return generateAndWaitForRoute(batchId, accessToken, [...removedOrders, ...(removeResult.merchantOrderIds || [])], attempt + 1);
      }

      const routeAlreadyReady = await isBatchRouteReady(batchId, accessToken);
      if (routeAlreadyReady) {
        return { ready: true, error: null };
      }

      return {
        ready: false,
        error: generateErrorMessage,
        errorCode: generateErrorCode ?? 40002,
        blitzGenerateError: true,
        rawError: generateErrorRaw,
      };
    }

    const routeAlreadyReady = await isBatchRouteReady(batchId, accessToken);
    if (routeAlreadyReady) {
      return { ready: true, error: null };
    }

    return { ready: false, error: generateErrorMessage, errorCode: generateErrorCode, rawError: generateErrorRaw };
  }

  await sleep(POST_GENERATE_DELAY_MS);

  const routeReady = await waitForRouteGeneration(batchId, accessToken);
  return { ready: routeReady, error: null };
};

const tryAssignDriver = async (batchId, driverId, lat, lng, accessToken) => {
  let lastAssignError;

  for (let attempt = 1; attempt <= ASSIGN_MAX_RETRIES; attempt++) {
    try {
      const assignResponse = await axios.post(
        BLITZ_ASSIGN_DRIVER_URL,
        {
          batch_id: parseInt(batchId),
          driver_id: parseInt(driverId),
          lat: parseFloat(lat),
          lng: parseFloat(lng),
          radius: '20km',
          allow_route_change: false,
          decline_batch_before_accept: false,
          accept_timer: 0,
          cancel_at_first_pickup: false,
          cancel_timer: 0,
        },
        {
          headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' },
          timeout: 30000,
        }
      );

      if (assignResponse.data.result) {
        return { success: true, data: assignResponse.data.data };
      }

      const errCode = assignResponse.data?.error?.code;
      const errMsg = assignResponse.data?.error?.message || assignResponse.data?.message || '';

      if (isAutoAssignInProgressError(errCode, errMsg)) {
        await sleep(AUTO_ASSIGN_VERIFY_DELAY_MS);
        const verification = await verifyAssignmentInBatch(batchId, driverId, accessToken);
        if (verification.assigned) {
          return { success: true, data: { driver_id: driverId, assignment_id: verification.assignmentId }, autoAssignInProgress: true };
        }
        lastAssignError = errMsg || 'Auto assignment in progress';
        if (attempt < ASSIGN_MAX_RETRIES) {
          await sleep(ASSIGN_RETRY_DELAY_MS * attempt);
          continue;
        }
        const finalVerification = await verifyAssignmentInBatch(batchId, driverId, accessToken);
        if (finalVerification.assigned) {
          return { success: true, data: { driver_id: driverId, assignment_id: finalVerification.assignmentId }, autoAssignInProgress: true };
        }
        return { success: true, data: { driver_id: driverId, assignment_id: null }, autoAssignInProgress: true, verifyFailed: true };
      }

      lastAssignError = extractBlitzErrorMessage(assignResponse.data) || 'Driver assignment failed';
    } catch (e) {
      const d = e.response?.data;
      const errCode = d?.error?.code;
      const errMsg = d?.error?.message || d?.message || e.message || '';

      if (isAutoAssignInProgressError(errCode, errMsg)) {
        await sleep(AUTO_ASSIGN_VERIFY_DELAY_MS);
        const verification = await verifyAssignmentInBatch(batchId, driverId, accessToken);
        if (verification.assigned) {
          return { success: true, data: { driver_id: driverId, assignment_id: verification.assignmentId }, autoAssignInProgress: true };
        }
        lastAssignError = errMsg || 'Auto assignment in progress';
        if (attempt < ASSIGN_MAX_RETRIES) {
          await sleep(ASSIGN_RETRY_DELAY_MS * attempt);
          continue;
        }
        const finalVerification = await verifyAssignmentInBatch(batchId, driverId, accessToken);
        if (finalVerification.assigned) {
          return { success: true, data: { driver_id: driverId, assignment_id: finalVerification.assignmentId }, autoAssignInProgress: true };
        }
        return { success: true, data: { driver_id: driverId, assignment_id: null }, autoAssignInProgress: true, verifyFailed: true };
      }

      lastAssignError = extractBlitzErrorMessage(d) || e.message;
      if (attempt === ASSIGN_MAX_RETRIES) {
        throw {
          statusCode: e.response?.status || 500,
          body: { success: false, message: lastAssignError, blitz_error: d },
        };
      }
    }

    if (attempt < ASSIGN_MAX_RETRIES) await sleep(ASSIGN_RETRY_DELAY_MS);
  }

  throw {
    statusCode: 400,
    body: { success: false, message: lastAssignError || 'Driver assignment failed' },
  };
};

const executeBatchFlow = async (accessToken, merchantOrderIds, hubId, driverId, coordinates, batchOnly, retryCount = 0) => {
  const validateResult = await validateBatchChunked(accessToken, merchantOrderIds, 0, hubId);
  if (!validateResult.success) {
    if (retryCount < MAX_VALIDATE_RETRIES) {
      await sleep(VALIDATE_RETRY_DELAY_MS);
      return executeBatchFlow(accessToken, merchantOrderIds, hubId, driverId, coordinates, batchOnly, retryCount + 1);
    }
    throw {
      statusCode: 400,
      body: {
        success: false,
        message: validateResult.message,
        errorCode: validateResult.errorCode || null,
        blitz_generate_error: validateResult.blitz_generate_error === true,
        blitz_error: validateResult.blitz_error,
        validation_errors: validateResult.validation_errors,
      },
    };
  }

  let saveResponse;
  try {
    saveResponse = await axios.post(
      BLITZ_SAVE_BATCH_URL,
      { batchId: 0, hub_id: hubId, sequence_type: 1, merchant_order_ids: merchantOrderIds },
      {
        headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' },
        timeout: BATCH_API_TIMEOUT_MS,
      }
    );
  } catch (e) {
    const d = e.response?.data;
    throw {
      statusCode: e.response?.status || 500,
      body: { success: false, message: extractBlitzErrorMessage(d) || e.message, blitz_error: d, validation_errors: extractValidationErrors(d) },
    };
  }

  if (!saveResponse.data.result)
    throw {
      statusCode: 400,
      body: { success: false, message: extractBlitzErrorMessage(saveResponse.data) || 'Save batch failed', blitz_error: saveResponse.data, validation_errors: extractValidationErrors(saveResponse.data) },
    };

  const batchId = saveResponse.data.data.batch_id;

  const generateResult = await generateAndWaitForRoute(batchId, accessToken, []);

  if (generateResult.error) {
    throw {
      statusCode: 400,
      body: {
        success: false,
        message: generateResult.error,
        blitz_error: { error: { code: generateResult.errorCode, message: generateResult.error } },
        batchId,
      },
    };
  }

  if (!generateResult.ready) {
    console.warn(`[batch-flow] Route not ready after polling for batchId=${batchId}, attempting assign anyway`);
  }

  if (batchOnly) return { batchId, assigned: false };

  const assignResult = await tryAssignDriver(batchId, driverId, coordinates[1], coordinates[0], accessToken);

  return { batchId, assigned: true, assignmentId: assignResult.data?.assignment_id, autoAssignInProgress: assignResult.autoAssignInProgress || false };
};

router.get('/token', async (req, res) => {
  try {
    const credentials = await getBlitzCredentials(req);
    delete tokenCache[credentials.username];
    const token = await loginToBlitz(credentials.username, credentials.password);
    tokenCache[credentials.username] = { token, expiry: Date.now() + TOKEN_TTL_MS };
    res.json({ success: true, token });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/search-orders', async (req, res) => {
  try {
    const { merchantOrderIds } = req.body;
    if (!merchantOrderIds || !Array.isArray(merchantOrderIds) || merchantOrderIds.length === 0)
      return res.status(400).json({ success: false, message: 'merchantOrderIds array is required' });

    const accessToken = await getAccessToken(req);
    const result = await searchBlitzOrdersBulk(merchantOrderIds, accessToken);

    res.json({
      success: true,
      data: result,
      totalSearched: merchantOrderIds.length,
      totalFound: Object.values(result).filter((v) => v?.exists).length,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to search Blitz orders', error: error.message });
  }
});

router.post('/add-to-existing-batch', async (req, res) => {
  try {
    const { orders, batchId, hubId, business, city, serviceType, driverId, project } = req.body;
    const credentials =
      driverId && project
        ? (await getCredentialsByDriverId(driverId, project)) || (await getBlitzCredentials(req))
        : await getBlitzCredentials(req);
    const accessToken = await loginToBlitz(credentials.username, credentials.password);
    tokenCache[credentials.username] = { token: accessToken, expiry: Date.now() + TOKEN_TTL_MS };

    const merchantOrderIds = orders.map((o) => o.merchant_order_id);
    const { needUpload, skipUpload } = await classifyOrdersByBlitzStatus(orders, accessToken);

    if (needUpload.length > 0) {
      try {
        await smartUpload(needUpload, hubId, business || 12, city || 9, serviceType || 2, credentials.username, credentials.password, credentials.role);
      } catch (uploadError) {
        if (uploadError instanceof AdminPanelValidationError) {
          return res.status(422).json({
            success: false,
            adminpanel_validation_error: true,
            message: `Validasi AdminPanel gagal: ${uploadError.adminpanel_errors.length} order ditolak`,
            adminpanel_errors: uploadError.adminpanel_errors,
            validation_errors: uploadError.adminpanel_errors.map(e => ({
              merchant_order_id: e.merchant_order_id || null,
              validation_message: e.validation_message || e.raw || 'Validation error',
              field: e.field || null,
            })),
          });
        }
        return res.status(500).json({ success: false, message: `Upload failed: ${uploadError.message}` });
      }
      const recheck = await waitUntilOrdersAppearInBlitz(
        needUpload.map((o) => o.merchant_order_id), accessToken
      );
      if (!recheck.success)
        return res.status(500).json({
          success: false,
          message: `Upload berhasil, namun beberapa order belum muncul.`,
          missingOrders: recheck.missing,
        });
    }

    const validateResult = await validateBatchChunked(accessToken, merchantOrderIds, batchId, hubId);
    if (!validateResult.success) {
      return res.status(400).json({
        success: false,
        message: validateResult.message,
        errorCode: validateResult.errorCode || null,
        blitz_generate_error: validateResult.blitz_generate_error === true,
        blitz_error: validateResult.blitz_error,
        validation_errors: validateResult.validation_errors,
      });
    }

    const addResult = await addToBatchChunked(accessToken, merchantOrderIds, batchId, hubId);
    if (!addResult.success) {
      return res.status(400).json({
        success: false,
        message: addResult.message,
        blitz_error: addResult.blitz_error,
        validation_errors: addResult.validation_errors,
      });
    }

    const generateResult = await generateAndWaitForRoute(batchId, accessToken, []);
    if (generateResult.error) {
      return res.status(400).json({
        success: false,
        message: generateResult.error,
        blitz_error: { error: { code: generateResult.errorCode, message: generateResult.error } },
        batchId,
      });
    }
    if (!generateResult.ready) {
      console.warn(`[add-to-existing-batch] Route not ready after polling for batchId=${batchId}`);
    }

    res.json({
      success: true, batchId,
      uploadedCount: needUpload.length,
      skippedCount: skipUpload.length,
      addedCount: merchantOrderIds.length,
      routeReady: generateResult.ready,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/batch-details/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    const accessToken = await getAccessToken(req);
    const response = await axios.get(`${BLITZ_BATCH_DETAILS_URL}/${batchId}`, {
      headers: { Accept: 'application/json', Authorization: accessToken, bt: '2' },
      timeout: 30000,
    });
    if (response.data.result && response.data.data) return res.json(response.data);
    res.status(404).json({ result: false, message: 'Batch not found' });
  } catch (error) {
    res.status(500).json({ result: false, message: 'Failed to get batch details', error: error.message });
  }
});

router.get('/active-batch/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const accessToken = await getAccessToken(req);
    const now = new Date();
    const jakartaOffset = 7 * 60 * 60 * 1000;
    const jNow = new Date(now.getTime() + jakartaOffset);
    const tomorrow = new Date(jNow.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sevenDaysAgo = new Date(jNow.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const response = await axios.get(`${BLITZ_DRIVER_PERFORMANCE_URL}/${driverId}`, {
      params: { sort: '-1', batchType: '', statusId: '', page: 1, offset: 100, term: '', createdFrom: sevenDaysAgo, createdTo: tomorrow },
      headers: { Accept: 'application/json', Authorization: accessToken },
      timeout: 30000,
    });
    if (!response.data?.result || !response.data?.data)
      return res.json({ success: true, batchId: null });
    const batches = response.data.data.driver_batch_performance_list;
    if (!Array.isArray(batches) || !batches.length)
      return res.json({ success: true, batchId: null });
    const activeBatch = batches.find((b) => b.assignment_status === 1);
    res.json({ success: true, batchId: activeBatch ? activeBatch.id : null });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get active batch', error: error.message });
  }
});

router.get('/driver-attendance/:driverPhone', async (req, res) => {
  try {
    const { driverPhone } = req.params;
    const accessToken = await getAccessToken(req);
    const response = await axios.get(BLITZ_DRIVER_LIST_URL, {
      params: { sort: '-1', status: '1,2,8,3,4,5,6,7', attendance: '', page: 1, offset: 100, term: driverPhone, app_version_name: '', bank_info_provided: 'undefined', _t: Date.now() },
      headers: { Accept: 'application/json', Authorization: accessToken },
      timeout: 30000,
    });
    if (response.data.result && response.data.data?.driver_list_response?.length > 0)
      return res.json({ success: true, status: response.data.data.driver_list_response[0].drivers?.attendance_status || 'offline' });
    res.json({ success: true, status: 'offline' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get driver attendance', error: error.message, status: 'offline' });
  }
});

router.get('/driver-profile/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const accessToken = await getAccessToken(req);
    const response = await axios.get(`${BLITZ_DRIVER_PROFILE_URL}/${driverId}`, {
      headers: { Accept: 'application/json', Authorization: accessToken },
      timeout: 30000,
    });
    if (response.data.result) return res.json({ success: true, data: response.data.data });
    res.json({ success: false, message: 'Driver profile not found' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get driver profile', error: error.message });
  }
});

router.post('/nearby-drivers', async (req, res) => {
  try {
    const { lat, lon } = req.body;
    const accessToken = await getAccessToken(req);
    const response = await axios.post(
      BLITZ_NEARBY_DRIVERS_URL,
      { lat: parseFloat(lat), lon: parseFloat(lon), radius: '20km', hub_ids: [], business_ids: [] },
      { headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    if (response.data.result) return res.json({ success: true, data: response.data.data });
    res.json({ success: false, message: 'Failed to fetch nearby drivers' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get nearby drivers', error: error.message });
  }
});

router.post('/validate-batch-orders', async (req, res) => {
  try {
    const { sequenceType, batchId, merchantOrderIds, hubId } = req.body;
    const accessToken = await getAccessToken(req);
    const response = await axios.post(
      BLITZ_VALIDATE_BATCH_URL,
      { sequence_type: sequenceType, batch_id: batchId, merchant_order_ids: merchantOrderIds, hub_id: hubId },
      { headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' }, timeout: BATCH_API_TIMEOUT_MS }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ result: false, message: 'Failed to validate batch orders', error: error.message });
  }
});

router.post('/add-batch-orders', async (req, res) => {
  try {
    const { sequenceType, batchId, merchantOrderIds, hubId } = req.body;
    const accessToken = await getAccessToken(req);
    try {
      const response = await axios.post(
        BLITZ_ADD_BATCH_URL,
        { sequence_type: sequenceType, batch_id: batchId, merchant_order_ids: merchantOrderIds, hub_id: hubId },
        { headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' }, timeout: BATCH_API_TIMEOUT_MS }
      );
      res.json(response.data);
    } catch (axiosError) {
      const d = axiosError.response?.data;
      res.status(axiosError.response?.status || 500).json({
        result: false, message: extractBlitzErrorMessage(d) || axiosError.message,
        blitz_error: d, validation_errors: extractValidationErrors(d),
      });
    }
  } catch (error) {
    res.status(500).json({ result: false, message: 'Failed to add batch orders', error: error.message });
  }
});

router.post('/create-batch-with-driver', async (req, res) => {
  try {
    const { orders, driverId, business, city, serviceType, hubId, coordinates, project, batchOnly } = req.body;
    const isBatchOnly = batchOnly === true || batchOnly === 'true';

    const credentials =
      driverId && project
        ? (await getCredentialsByDriverId(driverId, project)) || (await getBlitzCredentials(req))
        : await getBlitzCredentials(req);

    const accessToken = await loginToBlitz(credentials.username, credentials.password);
    tokenCache[credentials.username] = { token: accessToken, expiry: Date.now() + TOKEN_TTL_MS };

    const { needUpload, skipUpload } = await classifyOrdersByBlitzStatus(orders, accessToken);

    if (needUpload.length > 0) {
      try {
        await smartUpload(needUpload, hubId, business || 12, city || 9, serviceType || 2, credentials.username, credentials.password, credentials.role);
      } catch (uploadError) {
        if (uploadError instanceof AdminPanelValidationError) {
          return res.status(422).json({
            success: false,
            adminpanel_validation_error: true,
            message: `Validasi AdminPanel gagal: ${uploadError.adminpanel_errors.length} order ditolak`,
            adminpanel_errors: uploadError.adminpanel_errors,
            validation_errors: uploadError.adminpanel_errors.map(e => ({
              merchant_order_id: e.merchant_order_id || null,
              validation_message: e.validation_message || e.raw || 'Validation error',
              field: e.field || null,
            })),
          });
        }
        return res.status(500).json({ success: false, message: 'Failed to upload missing orders', error: uploadError.message });
      }

      const recheck = await waitUntilOrdersAppearInBlitz(
        needUpload.map((o) => o.merchant_order_id), accessToken
      );
      if (!recheck.success) await sleep(POST_UPLOAD_DELAY_MS);
    }

    const merchantOrderIds = orders.map((o) => o.merchant_order_id);

    try {
      const result = await executeBatchFlow(accessToken, merchantOrderIds, hubId, driverId, coordinates, isBatchOnly);

      if (project && driverId) {
        try {
          const driverDoc = await mongoose.connection.db
            .collection(`${project}_delivery`)
            .findOne({ driver_id: driverId.toString() });
          if (driverDoc) {
            const collection = mongoose.connection.db.collection(`${project}_merchant_orders`);
            const updateOps = orders.map((o) => ({
              updateOne: {
                filter: { merchant_order_id: o.merchant_order_id },
                update: { $set: { account_driver_name: driverDoc.driver_name || null, account_driver_phone: driverDoc.driver_phone || null } },
              },
            }));
            if (updateOps.length > 0) await collection.bulkWrite(updateOps, { ordered: false });
          }
        } catch {}
      }

      res.json({
        success: true, batchId: result.batchId,
        uploadedCount: needUpload.length,
        skippedCount: skipUpload.length,
        batchOnly: isBatchOnly, assigned: result.assigned,
        assignmentId: result.assignmentId || null,
        autoAssignInProgress: result.autoAssignInProgress || false,
      });
    } catch (flowError) {
      if (flowError.statusCode && flowError.body) return res.status(flowError.statusCode).json(flowError.body);
      throw flowError;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/remove-order-from-batch', async (req, res) => {
  try {
    const { batchId, merchantOrderId, orderId, project } = req.body;
    const validationData = await getValidationDataByMerchantOrderId(project, merchantOrderId);
    if (!validationData)
      return res.status(400).json({ success: false, message: `Validation data not found for order ${merchantOrderId}.` });
    const hubId = validationData.business_hub;
    const accessToken = await getAccessToken(req);

    const validateResponse = await axios.post(
      `${BLITZ_REMOVE_VALIDATE_URL}/${batchId}`,
      { merchant_order_id: merchantOrderId },
      { headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' }, timeout: 30000 }
    );
    if (validateResponse.status !== 200) throw new Error('Validation failed');

    const removeResponse = await axios.post(
      BLITZ_REMOVE_ORDER_URL,
      { sequence_type: 1, batch_id: batchId, merchant_order_ids: [merchantOrderId], hub_id: hubId },
      { headers: { Accept: 'application/json', Authorization: accessToken, 'Content-Type': 'application/json', bt: '2' }, timeout: 30000 }
    );
    if (removeResponse.status !== 200) throw new Error('Remove from Blitz failed');

    bulkOrderCache.delete(merchantOrderId);
    await mongoose.connection.db.collection(`${project}_merchant_orders`).updateOne(
      { _id: new mongoose.Types.ObjectId(orderId) },
      { $set: { assigned_to_driver_id: null, assigned_to_driver_name: null, assigned_to_driver_phone: null, assigned_at: null, assignment_status: 'unassigned', batch_id: null } }
    );
    res.json({ success: true, message: 'Order removed successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to remove order from batch', error: error.message });
  }
});

router.post('/refresh-token', async (req, res) => {
  try {
    const credentials = await getBlitzCredentials(req);
    delete tokenCache[credentials.username];
    const token = await loginToBlitz(credentials.username, credentials.password);
    tokenCache[credentials.username] = { token, expiry: Date.now() + TOKEN_TTL_MS };
    res.json({ success: true, message: 'Token refreshed successfully', expiresIn: '55 minutes' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to refresh token', error: error.message });
  }
});

router.post('/clear-cache', async (req, res) => {
  try {
    const credentials = await getBlitzCredentials(req);
    if (tokenCache[credentials.username]) delete tokenCache[credentials.username];
    bulkOrderCache.clear();
    inFlightByIdMap.clear();
    res.json({ success: true, message: `Cache cleared for ${credentials.username}` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to clear cache', error: error.message });
  }
});

router.post('/distance-matrix', async (req, res) => {
  try {
    const { origin, dest } = req.body;
    if (!origin?.lat || !origin?.lng || !dest?.lat || !dest?.lng) {
      return res.status(400).json({ success: false, message: 'origin and dest coordinates required' });
    }

    const GOOGLE_MAPS_KEY = 'AIzaSyD4sgjH4RAaAokyujwQO_jSeZDowQ1U9Oo';

    const tryRoutesAPI = async () => {
      const response = await axios.post(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        {
          origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
          destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
          travelMode: 'TWO_WHEELER',
          routingPreference: 'TRAFFIC_AWARE',
          computeAlternativeRoutes: false,
          languageCode: 'id',
          units: 'METRIC',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
            'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
          },
          timeout: 10000,
        }
      );
      const route = response.data?.routes?.[0];
      if (route?.distanceMeters) {
        return (route.distanceMeters / 1000).toFixed(2);
      }
      return null;
    };

    const tryDistanceMatrix = async (mode) => {
      const url =
        `https://maps.googleapis.com/maps/api/distancematrix/json` +
        `?origins=${origin.lat},${origin.lng}` +
        `&destinations=${dest.lat},${dest.lng}` +
        `&mode=${mode}` +
        `&key=${GOOGLE_MAPS_KEY}`;
      const response = await axios.get(url, { timeout: 10000 });
      const element = response.data?.rows?.[0]?.elements?.[0];
      if (element?.status === 'OK') {
        return (element.distance.value / 1000).toFixed(2);
      }
      return null;
    };

    let distanceKm = await tryRoutesAPI().catch(() => null);
    if (distanceKm == null) distanceKm = await tryDistanceMatrix('TWO_WHEELER').catch(() => null);
    if (distanceKm == null) distanceKm = await tryDistanceMatrix('driving').catch(() => null);

    if (distanceKm != null) {
      return res.json({ success: true, distanceKm });
    }

    res.json({ success: false, message: 'No route found', distanceKm: null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, distanceKm: null });
  }
});

router.post('/generate-and-assign', async (req, res) => {
  try {
    const { batchId, driverId, lat, lon, project } = req.body;

    if (!batchId || !driverId) {
      return res.status(400).json({ success: false, message: 'batchId and driverId are required' });
    }

    const credentials =
      driverId && project
        ? (await getCredentialsByDriverId(driverId, project)) || (await getBlitzCredentials(req))
        : await getBlitzCredentials(req);

    const accessToken = await loginToBlitz(credentials.username, credentials.password);
    tokenCache[credentials.username] = { token: accessToken, expiry: Date.now() + TOKEN_TTL_MS };

    const generateResult = await generateAndWaitForRoute(batchId, accessToken, []);

    if (generateResult.error) {
      return res.status(400).json({
        success: false,
        message: generateResult.error,
        errorCode: generateResult.errorCode ?? 40002,
        blitz_generate_error: generateResult.blitzGenerateError === true,
        blitz_error: generateResult.rawError || { error: { code: generateResult.errorCode ?? 40002, message: generateResult.error } },
        batchId,
      });
    }

    if (!generateResult.ready) {
      console.warn(`[generate-and-assign] Route not ready after polling for batchId=${batchId}, proceeding anyway`);
    }

    let assignResult;
    try {
      assignResult = await tryAssignDriver(
        batchId,
        driverId,
        parseFloat(lat) || -6.2093097,
        parseFloat(lon) || 106.9151781,
        accessToken
      );
    } catch (assignError) {
      if (assignError.statusCode && assignError.body) {
        const errCode = assignError.body?.blitz_error?.error?.code;
        const errMsg = assignError.body?.blitz_error?.error?.message || assignError.body?.message || '';

        if (isAutoAssignInProgressError(errCode, errMsg)) {
          await sleep(AUTO_ASSIGN_VERIFY_DELAY_MS);
          const verification = await verifyAssignmentInBatch(batchId, driverId, accessToken);
          if (verification.assigned) {
            return res.json({
              success: true,
              batchId,
              driverId,
              assignmentId: verification.assignmentId || null,
              routeReady: generateResult.ready,
              autoAssignInProgress: true,
            });
          }
          return res.json({
            success: true,
            batchId,
            driverId,
            assignmentId: null,
            routeReady: generateResult.ready,
            autoAssignInProgress: true,
            message: 'Auto assignment sedang diproses oleh sistem Blitz.',
          });
        }
        return res.status(assignError.statusCode).json(assignError.body);
      }
      throw assignError;
    }

    res.json({
      success: true,
      batchId,
      driverId: assignResult.data?.driver_id || driverId,
      assignmentId: assignResult.data?.assignment_id || null,
      routeReady: generateResult.ready,
      autoAssignInProgress: assignResult.autoAssignInProgress || false,
    });
  } catch (error) {
    if (error.statusCode && error.body) {
      return res.status(error.statusCode).json(error.body);
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/debug-generate/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    const accessToken = await getAccessToken(req);
    const results = {};

    try {
      const r = await axios.get(`${BLITZ_GENERATE_BATCH_URL}/${batchId}`, {
        headers: { Accept: 'application/json', Authorization: accessToken, bt: '2' },
        timeout: 30000,
      });
      results.generate = { status: r.status, data: r.data };
    } catch (e) {
      results.generate = { status: e.response?.status, data: e.response?.data, error: e.message };
    }

    const nodes = await getNodesInBatch(batchId, accessToken);
    results.nodes = nodes.map(n => ({
      node_id: n.node_id,
      node_type: n.node_type,
      coordinate: n.coordinate,
      orders: n.orders,
      coordinate_valid: n.coordinate
        ? (() => {
          const lat = n.coordinate.latitude ?? n.coordinate.lat;
          const lon = n.coordinate.longitude ?? n.coordinate.lon ?? n.coordinate.lng;
          return isCoordinateValid(lat, lon) ? 'valid' : `INVALID (${lat},${lon})`;
        })()
        : 'no coordinate',
    }));

    results.invalid_nodes = results.nodes.filter(n => n.coordinate_valid !== 'valid' && n.coordinate_valid !== 'no coordinate');

    res.json({ success: true, batchId, results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/fix-coordinates', async (req, res) => {
  try {
    const { orders, project } = req.body;

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ success: false, message: 'orders array is required' });
    }

    const FIX_COORD_SCRIPT = path.join(__dirname, '..', 'utils', 'fix_coordinates.py');

    if (!fs.existsSync(FIX_COORD_SCRIPT)) {
      return res.status(500).json({ success: false, message: 'fix_coordinates.py not found' });
    }

    const credentials = await getBlitzCredentials(req);

    const payload = JSON.stringify({
      username: credentials.username,
      password: credentials.password,
      orders: orders.map(o => ({
        merchantOrderId: o.merchantOrderId,
        consigneeName: o.consigneeName || '',
        destinationAddress: o.destinationAddress || '',
        destinationCity: o.destinationCity || '',
        destinationDistrict: o.destinationDistrict || '',
      })),
    });

    const timeoutMs = Math.max(300000, orders.length * 30000);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const proc = spawn('python3', [FIX_COORD_SCRIPT], {
      env: { ...process.env },
    });

    proc.stdin.write(payload);
    proc.stdin.end();

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let finalSent = false;
    const accumulatedResults = [];

    const timeoutHandle = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      if (!finalSent) {
        finalSent = true;
        res.end(JSON.stringify({
          success: false,
          message: `fix_coordinates.py timeout after ${timeoutMs / 1000}s`,
          results: accumulatedResults,
        }));
      }
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.results && Array.isArray(parsed.results)) {
            const isFinal = parsed.successCount !== undefined || parsed.failCount !== undefined;
            if (!isFinal) {
              for (const r of parsed.results) {
                const existingIdx = accumulatedResults.findIndex(x => x.merchantOrderId === r.merchantOrderId);
                if (existingIdx >= 0) {
                  accumulatedResults[existingIdx] = r;
                } else {
                  accumulatedResults.push(r);
                }
              }
              res.write(trimmed + '\n');
            }
          }
        } catch {}
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
    });

    proc.on('close', async (code) => {
      clearTimeout(timeoutHandle);

      if (stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer.trim());
          if (parsed.results && Array.isArray(parsed.results)) {
            const successResults = parsed.results.filter(r => r.success && r.lat && r.lng);
            if (project && successResults.length > 0) {
              try {
                const collection = mongoose.connection.db.collection(`${project}_merchant_orders`);
                const bulkOps = successResults.map(r => ({
                  updateOne: {
                    filter: { merchant_order_id: r.merchantOrderId },
                    update: { $set: { dropoff_lat: r.lat, dropoff_long: r.lng } },
                  },
                }));
                await collection.bulkWrite(bulkOps, { ordered: false });
              } catch {}
            }
            if (!finalSent) {
              finalSent = true;
              res.end(JSON.stringify(parsed));
            }
            return;
          }
        } catch {}
      }

      if (!finalSent) {
        if (accumulatedResults.length > 0) {
          const successCount = accumulatedResults.filter(r => r.success).length;
          const failCount = accumulatedResults.length - successCount;

          if (project && successCount > 0) {
            try {
              const successResults = accumulatedResults.filter(r => r.success && r.lat && r.lng);
              const collection = mongoose.connection.db.collection(`${project}_merchant_orders`);
              const bulkOps = successResults.map(r => ({
                updateOne: {
                  filter: { merchant_order_id: r.merchantOrderId },
                  update: { $set: { dropoff_lat: r.lat, dropoff_long: r.lng } },
                },
              }));
              if (bulkOps.length > 0) await collection.bulkWrite(bulkOps, { ordered: false });
            } catch {}
          }

          finalSent = true;
          res.end(JSON.stringify({
            success: successCount > 0,
            results: accumulatedResults,
            successCount,
            failCount,
          }));
        } else if (code !== 0) {
          finalSent = true;
          res.end(JSON.stringify({
            success: false,
            message: `fix_coordinates.py exited with code ${code}: ${stderrBuffer.slice(0, 500)}`,
            results: [],
          }));
        } else {
          finalSent = true;
          res.end(JSON.stringify({
            success: false,
            message: 'Invalid response from fix_coordinates.py',
            results: [],
          }));
        }
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timeoutHandle);
      if (!finalSent) {
        finalSent = true;
        res.end(JSON.stringify({ success: false, message: e.message, results: [] }));
      }
    });

  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
});

module.exports = router;