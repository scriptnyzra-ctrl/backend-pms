const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/prospectPartnerController');

router.post('/upload', ctrl.uploadProspectPartners);
router.get('/data', ctrl.getAllProspectPartners);
router.put('/data/:id', ctrl.updateProspectPartner);
router.delete('/data/bulk-delete', ctrl.bulkDeleteProspectPartners);
router.delete('/data/:id', ctrl.deleteProspectPartner);
router.get('/map/distribution', ctrl.getMapDistribution);
router.get('/map/summary', ctrl.getMapSummary);
router.post('/data/:id/geocode', ctrl.retryGeocode);

module.exports = router;