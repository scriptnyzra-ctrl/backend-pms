const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/authMiddleware');

let controller;
try {
  controller = require('../controllers/mitraExtendedController');
} catch (err) {
  console.error('Failed to load mitraExtendedController:', err.message);
  controller = null;
}

const safeHandler = (fn) => (req, res, next) => {
  if (!controller) {
    return res.status(500).json({ success: false, message: 'Controller failed to initialize: ' + fn });
  }
  return controller[fn](req, res, next);
};

router.get('/extended/bulk-all', authenticate, safeHandler('getBulkMitraExtendedData'));
router.post('/extended/manual-sync', authenticate, authorize('owner'), safeHandler('manualSyncController'));
router.post('/extended/cancel-sync', authenticate, authorize('owner'), safeHandler('cancelSyncEndpoint'));
router.get('/extended/:driver_id', authenticate, safeHandler('getExtendedDataByDriverId'));
router.put('/extended/:driver_id', authenticate, safeHandler('createOrUpdateExtendedData'));
router.delete('/extended/:driver_id', authenticate, safeHandler('deleteExtendedData'));

module.exports = router;