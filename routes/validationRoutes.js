// validationRoutes.js
// Route: GET /api/validations/sender-location?sender_name=xxx
// Returns pickup coordinate from adminpanel_validations collection

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

// GET /api/validations/sender-location?sender_name=JNE+Depok+-+RS+Primaya+Hospital+Depok
router.get("/sender-location", async (req, res) => {
  const { sender_name } = req.query;
  if (!sender_name) {
    return res.status(400).json({ error: "sender_name is required" });
  }

  try {
    const db = mongoose.connection.db;
    const collection = db.collection("adminpanel_validations");
    const doc = await collection.findOne(
      { sender_name: sender_name },
      { projection: { sender_name: 1, location: 1 } }
    );

    if (!doc) {
      return res.status(404).json({ error: "sender not found" });
    }

    return res.json({
      sender_name: doc.sender_name,
      location: doc.location, // { type: "Point", coordinates: [lng, lat] }
    });
  } catch (err) {
    console.error("[validationRoutes] Error:", err);
    return res.status(500).json({ error: "internal server error" });
  }
});

module.exports = router;