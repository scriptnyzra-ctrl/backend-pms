const mongoose = require('mongoose');

const FleetDataSchema = new mongoose.Schema({
  vehNumb: { type: String, required: true, trim: true, uppercase: true, index: true },
  unitBrand: { type: String, trim: true, default: '' },
  type: { type: String, trim: true, default: '', index: true },
  unitColour: { type: String, trim: true, default: '' },
  category: { type: String, trim: true, default: '' },
  name: { type: String, trim: true, default: '', index: true },
  project: { type: String, trim: true, default: '', index: true },
  pic: { type: String, trim: true, default: '' },
  distribusi: { type: String, trim: true, default: '' },
  releaseDate: { type: String, trim: true, default: '' },
  returnDate: { type: String, trim: true, default: '' },
  hoDate: { type: String, trim: true, default: '' },
  molis: { type: String, trim: true, default: '' },
  deductionAmount: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  status: { type: String, trim: true, default: '', index: true },
  phoneNumber: { type: String, trim: true, default: '' },
  rushHour: { type: String, trim: true, default: '' },
  statusSecond: { type: String, trim: true, default: '' },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now },
});

FleetDataSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

FleetDataSchema.index({ vehNumb: 1 }, { unique: true });
FleetDataSchema.index({ status: 1, project: 1 });
FleetDataSchema.index({ project: 1, type: 1 });
FleetDataSchema.index({ createdAt: -1, status: 1 });
FleetDataSchema.index({
  name: 'text',
  vehNumb: 'text',
  project: 'text',
  type: 'text',
  unitBrand: 'text',
  distribusi: 'text',
  category: 'text',
  pic: 'text',
});

module.exports = mongoose.model('FleetData', FleetDataSchema);