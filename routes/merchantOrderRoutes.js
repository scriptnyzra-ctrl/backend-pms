const express = require('express');
const router = express.Router();
const merchantOrderController = require('../controllers/merchantOrderController');
const { authenticateMitra } = require('../middleware/mitraAuthMiddleware');

router.post('/:project/upload', merchantOrderController.uploadMerchantOrders);
router.get('/:project/all', merchantOrderController.getAllMerchantOrdersAdmin);
router.get('/:project/mitra/all', authenticateMitra, merchantOrderController.getAllMerchantOrders);
router.delete('/:project/all', merchantOrderController.deleteAllMerchantOrders);
router.delete('/:project/by-senders', merchantOrderController.deleteBySenderNames);
router.post('/:project/validate-sender', merchantOrderController.validateSender);
router.post('/:project/validate-multiple-senders', merchantOrderController.validateMultipleSenders);
router.post('/:project/sender-coordinates', merchantOrderController.getSenderCoordinates);
router.post('/:project/assign-with-blitz', authenticateMitra, merchantOrderController.assignWithBlitz);
router.post('/:project/assign-with-blitz-admin', merchantOrderController.assignWithBlitz);
router.post('/:project/migrate-completed', merchantOrderController.migrateCompletedStatus);
router.post('/:project/mark-completed-bulk', authenticateMitra, merchantOrderController.markOrdersCompletedBulk);
router.post('/:project/mark-completed-bulk-admin', merchantOrderController.markOrdersCompletedBulk);
router.post('/:project/sync-from-spreadsheet', authenticateMitra, merchantOrderController.syncFromSpreadsheet);
router.patch('/:project/:merchantOrderId/photo-address', authenticateMitra, merchantOrderController.updatePhotoAndAddress);
router.get('/:project/:id', merchantOrderController.getMerchantOrderById);
router.put('/:project/:id', merchantOrderController.updateMerchantOrder);
router.delete('/:project/:id', merchantOrderController.deleteMerchantOrder);

module.exports = router;