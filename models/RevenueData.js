const mongoose = require('mongoose');

const RevenueDataSchema = new mongoose.Schema({
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RevenueFile',
    required: true,
    index: true,
  },
  day: { type: String, trim: true, default: '' },
  orderRef: { type: String, trim: true, default: '', index: true },
  customerName: { type: String, trim: true, default: '', index: true },
  productTitle: { type: String, trim: true, default: '' },
  price: { type: Number, default: 0 },
  netSales: { type: Number, default: 0 },
  itemNotes: { type: String, trim: true, default: '' },
  itemQty: { type: Number, default: 1 },
  platNo: { type: String, trim: true, default: '', index: true },
  type: { type: String, trim: true, default: '' },
  cost: { type: Number, default: 0 },
  totalCost: { type: Number, default: 0 },
  picProject: { type: String, trim: true, default: '', index: true },
  week: { type: String, trim: true, default: '' },
  komisi: { type: Number, default: 0 },
  totalKomisi: { type: Number, default: 0 },
  lastPaymentDate: { type: String, trim: true, default: '' },
  category: { type: String, trim: true, default: '', index: true },
  area: { type: String, trim: true, default: '', index: true },
  createdAt: { type: Date, default: Date.now, index: true },
});

RevenueDataSchema.index({ fileId: 1, createdAt: -1 });
RevenueDataSchema.index({ fileId: 1, category: 1 });
RevenueDataSchema.index({ fileId: 1, area: 1 });
RevenueDataSchema.index({ fileId: 1, picProject: 1 });
RevenueDataSchema.index({ fileId: 1, week: 1 });
RevenueDataSchema.index(
  { customerName: 'text', platNo: 'text', productTitle: 'text', orderRef: 'text', picProject: 'text' }
);

module.exports = mongoose.model('RevenueData', RevenueDataSchema);