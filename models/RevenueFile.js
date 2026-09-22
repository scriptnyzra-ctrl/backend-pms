const mongoose = require('mongoose');

const RevenueFileSchema = new mongoose.Schema({
  fileName: {
    type: String,
    required: true,
    trim: true,
  },
  recordCount: {
    type: Number,
    default: 0,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  meta: {
    totalRevenue: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    totalKomisi: { type: Number, default: 0 },
    totalProfit: { type: Number, default: 0 },
  },
});

RevenueFileSchema.index({ uploadedAt: -1 });

module.exports = mongoose.model('RevenueFile', RevenueFileSchema);