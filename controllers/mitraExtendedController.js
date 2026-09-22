const MitraExtended = require('../models/MitraExtended');
const cacheWarmer = require('../services/cacheWarmer');
const { manualSyncMitraExtended, cancelSync, cancelAllSyncs } = require('../services/mitraExtendedSyncService');

const getBulkMitraExtendedData = async (req, res) => {
  const startTime = Date.now();
  try {
    let cachedData = cacheWarmer.getCachedData('mitraExtended');
    if (!cachedData || !Array.isArray(cachedData)) {
      cachedData = await MitraExtended.find({}).select('-__v').lean().maxTimeMS(60000).exec();
      if (Array.isArray(cachedData) && cachedData.length > 0) {
        cacheWarmer.setCachedData('mitraExtended', cachedData);
      }
    }
    if (!Array.isArray(cachedData)) cachedData = [];
    return res.status(200).json({
      success: true,
      data: cachedData,
      pagination: {
        currentPage: 1,
        totalPages: cachedData.length > 0 ? 1 : 0,
        totalRecords: cachedData.length,
        hasNextPage: false
      },
      meta: {
        queryTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        source: cachedData.length > 0 ? 'cache' : 'database'
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch mitra extended data',
      error: error.message,
      queryTime: Date.now() - startTime
    });
  }
};

const manualSyncController = async (req, res) => {
  const syncId = `sync_${Date.now()}`;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
    res.socket.setKeepAlive(true, 1000);
  }

  res.flushHeaders();

  let streamClosed = false;
  let keepAliveInterval = null;

  const tryFlush = () => {
    try {
      if (typeof res.flush === 'function') res.flush();
    } catch {}
  };

  const sendEvent = (data) => {
    if (streamClosed || res.writableEnded || res.destroyed) return false;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      tryFlush();
      return true;
    } catch (e) {
      console.error('[SSE] Write error:', e.message);
      streamClosed = true;
      return false;
    }
  };

  const closeStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    clearInterval(keepAliveInterval);
    try {
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch {}
  };

  keepAliveInterval = setInterval(() => {
    if (streamClosed || res.writableEnded || res.destroyed) {
      clearInterval(keepAliveInterval);
      return;
    }
    try {
      res.write(': keepalive\n\n');
      tryFlush();
    } catch {
      clearInterval(keepAliveInterval);
      streamClosed = true;
    }
  }, 2000);

  req.on('close', () => { cancelSync(syncId); streamClosed = true; clearInterval(keepAliveInterval); });
  req.on('error', () => { cancelSync(syncId); streamClosed = true; clearInterval(keepAliveInterval); });
  res.on('close', () => { streamClosed = true; clearInterval(keepAliveInterval); });

  if (req.user?.role !== 'owner') {
    sendEvent({ type: 'error', stage: 'error', message: 'Access denied. Only owner role.', percentage: 0, syncId });
    return closeStream();
  }

  sendEvent({ type: 'progress', stage: 'init', message: 'Starting sync...', percentage: 0, syncId });

  try {
    const result = await manualSyncMitraExtended(syncId, (progress) => {
      if (!streamClosed) {
        sendEvent({ type: 'progress', ...progress, syncId });
      }
    });

    clearInterval(keepAliveInterval);

    if (!streamClosed) {
      try {
        cacheWarmer.clearCache('mitraExtended');
        await cacheWarmer.warmMitraExtendedCache();
      } catch (cacheErr) {
        console.warn('[Sync] Cache refresh error:', cacheErr.message);
      }

      sendEvent({ type: 'complete', stage: 'complete', message: `Sync completed: ${result.successCount || 0} records saved`, percentage: 100, data: result, syncId });
      await new Promise(r => setTimeout(r, 500));
    }

    closeStream();

  } catch (error) {
    clearInterval(keepAliveInterval);
    const isCancelled = error.isCancelled || streamClosed;

    try {
      cacheWarmer.clearCache('mitraExtended');
      cacheWarmer.warmMitraExtendedCache().catch(() => {});
    } catch {}

    if (!streamClosed && !res.writableEnded) {
      if (isCancelled) {
        sendEvent({ type: 'cancelled', stage: 'cancelled', message: 'Sync cancelled', percentage: 0, syncId });
      } else {
        sendEvent({ type: 'error', stage: 'error', message: error.message || 'Sync failed', error: error.message, syncId });
      }
      await new Promise(r => setTimeout(r, 500));
    }

    closeStream();
  }
};

const cancelSyncEndpoint = async (req, res) => {
  try {
    if (req.user?.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const { syncId } = req.body;
    if (syncId) {
      const cancelled = cancelSync(syncId);
      cacheWarmer.clearCache('mitraExtended');
      return res.status(200).json({ success: true, message: cancelled ? `Sync ${syncId} cancelled` : `Sync ${syncId} not found`, syncId });
    }
    const count = cancelAllSyncs();
    cacheWarmer.clearCache('mitraExtended');
    return res.status(200).json({ success: true, message: `Cancelled ${count} sync(s)`, cancelledCount: count });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to cancel sync', error: error.message });
  }
};

const getExtendedDataByDriverId = async (req, res) => {
  try {
    const { driver_id } = req.params;
    if (!driver_id) return res.status(400).json({ success: false, message: 'Driver ID is required' });
    const data = await MitraExtended.findOne({ driver_id }).lean().exec();
    if (!data) return res.status(404).json({ success: false, message: 'Extended data not found' });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch extended data', error: error.message });
  }
};

const createOrUpdateExtendedData = async (req, res) => {
  try {
    const { driver_id } = req.params;
    if (!driver_id) return res.status(400).json({ success: false, message: 'Driver ID is required' });
    const data = await MitraExtended.findOneAndUpdate(
      { driver_id },
      { $set: { ...req.body, driver_id, updated_at: new Date() } },
      { new: true, upsert: true, runValidators: true, lean: true }
    );
    cacheWarmer.clearCache('mitraExtended');
    return res.status(200).json({ success: true, message: 'Extended data saved successfully', data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to save extended data', error: error.message });
  }
};

const deleteExtendedData = async (req, res) => {
  try {
    const { driver_id } = req.params;
    if (!driver_id) return res.status(400).json({ success: false, message: 'Driver ID is required' });
    const deleted = await MitraExtended.findOneAndDelete({ driver_id }).lean();
    if (!deleted) return res.status(404).json({ success: false, message: 'Extended data not found' });
    cacheWarmer.clearCache('mitraExtended');
    return res.status(200).json({ success: true, message: 'Extended data deleted successfully', data: deleted });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete extended data', error: error.message });
  }
};

module.exports = {
  getExtendedDataByDriverId,
  createOrUpdateExtendedData,
  deleteExtendedData,
  getBulkMitraExtendedData,
  manualSyncController,
  cancelSyncEndpoint
};