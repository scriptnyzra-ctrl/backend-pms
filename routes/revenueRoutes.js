const express = require('express');
const router = express.Router();
const {
  uploadRevenue,
  getRevenueFiles,
  getRevenueData,
  getRevenueSummary,
  deleteRevenueFile,
  updateRevenueRecord,
  deleteRevenueRecord,
} = require('../controllers/revenueController');

const logRequest = (req, res, next) => {
  const start = Date.now();
  const id = `${req.method}_${req.originalUrl}_${start}`;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} — ${id}`);
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} — ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
};

const validateUpload = (req, res, next) => {
  const { fileName, data } = req.body;
  if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
    return res.status(400).json({ success: false, message: 'fileName wajib diisi' });
  }
  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ success: false, message: 'data harus berupa array yang tidak kosong' });
  }
  next();
};

const validateId = (req, res, next) => {
  const id = req.params.id;
  if (!id || !/^[a-f\d]{24}$/i.test(id)) {
    return res.status(400).json({ success: false, message: 'ID tidak valid' });
  }
  next();
};

const handleAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const handleErrors = (err, req, res, next) => {
  console.error(`Revenue route error: ${err.message}`);
  res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
};

router.use(logRequest);

router.post('/upload', validateUpload, handleAsync(uploadRevenue));
router.get('/files', handleAsync(getRevenueFiles));
router.delete('/files/:id', validateId, handleAsync(deleteRevenueFile));
router.get('/data', handleAsync(getRevenueData));
router.get('/summary', handleAsync(getRevenueSummary));
router.put('/records/:id', validateId, handleAsync(updateRevenueRecord));
router.delete('/records/:id', validateId, handleAsync(deleteRevenueRecord));

router.use(handleErrors);

module.exports = router;