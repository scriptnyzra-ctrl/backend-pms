const mongoose = require("mongoose");

const deliveryMonitoringSchema = new mongoose.Schema(
  {
    driver_id: { type: String, required: true, trim: true },
    driver_name: { type: String, trim: true, default: "" },
    driver_phone: { type: String, trim: true, default: "" },
    driver_status: { type: String, trim: true, default: "" },
    is_occupied: { type: Boolean, default: false },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    vendor_id: { type: String, trim: true, default: "" },
    rating: { type: String, trim: true, default: "" },
    business_ids: { type: [String], default: [] },
    radius: { type: String, trim: true, default: "" },
    searched_coordinate: {
      lat: { type: Number, default: null },
      lon: { type: Number, default: null },
    },
    fetched_at: { type: Date, default: Date.now },
    is_new_on_last_fetch: { type: Boolean, default: null },
  },
  { timestamps: true }
);

deliveryMonitoringSchema.index({ driver_id: 1 }, { unique: true });
deliveryMonitoringSchema.index({ fetched_at: -1 });
deliveryMonitoringSchema.index({ driver_status: 1 });
deliveryMonitoringSchema.index({ radius: 1 });

module.exports = mongoose.model("DeliveryMonitoring", deliveryMonitoringSchema);