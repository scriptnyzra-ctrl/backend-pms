const mongoose = require('mongoose');

const geoSchema = new mongoose.Schema(
  {
    originalAddress: String,
    normalizedAddress: String,
    latitude: Number,
    longitude: Number,
    kecamatan: String,
    kelurahan: String,
    kabupatenKota: String,
    provinsi: String,
    formattedAddress: String,
    placeId: String,
    geocodedAt: Date,
    geocodeFailed: { type: Boolean, default: false },
  },
  { _id: false }
);

const prospectPartnerSchema = new mongoose.Schema(
  {
    fullName: { type: String, trim: true },
    phoneNumber: {
      type: String,
      required: [true, 'Phone Number is required'],
      trim: true,
    },
    emailAddress: { type: String, trim: true, lowercase: true },
    domicileAddress: { type: String, trim: true },
    occupation: { type: String, trim: true },
    companyName: { type: String, trim: true },
    workDuration: { type: String, trim: true },
    proofImage: { type: String, trim: true },
    preparationDate: { type: Date, default: null },
    assignedTo: { type: String, trim: true },
    notes: { type: String, trim: true, default: '' },
    previousIncome: { type: Number, default: null },
    performanceRating: {
      type: String,
      enum: ['Basic', 'Standard', 'Advanced', 'Professional', 'Elite', ''],
      default: '',
    },
    eligibilityStatus: {
      type: String,
      enum: ['Eligible', 'Need Review', 'Not Eligible', 'Potential Partner'],
      default: 'Need Review',
    },
    geo: { type: geoSchema, default: () => ({}) },
  },
  { timestamps: true }
);

prospectPartnerSchema.index({ phoneNumber: 1 }, { unique: true, sparse: true });
prospectPartnerSchema.index({ 'geo.provinsi': 1 });
prospectPartnerSchema.index({ 'geo.kabupatenKota': 1 });
prospectPartnerSchema.index({ eligibilityStatus: 1 });
prospectPartnerSchema.index({ assignedTo: 1 });
prospectPartnerSchema.index({ preparationDate: -1 });
prospectPartnerSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ProspectPartner', prospectPartnerSchema);