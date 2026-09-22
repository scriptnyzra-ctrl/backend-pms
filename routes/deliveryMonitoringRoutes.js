const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/deliveryMonitoringController");

router.get("/", ctrl.getAll);
router.post("/fetch", ctrl.fetchAndSave);
router.post("/login", ctrl.loginBlitz);
router.delete("/:id", ctrl.deleteOne);

module.exports = router;