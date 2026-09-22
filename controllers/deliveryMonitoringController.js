const DeliveryMonitoring = require("../models/DeliveryMonitoring");
const { fetchDriversByCoordinate, login } = require("../services/rideblitzLocationService");

const validateCoordinate = (lat, lon) => {
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  if (isNaN(latNum) || latNum < -90 || latNum > 90) return "Latitude tidak valid (harus antara -90 dan 90)";
  if (isNaN(lonNum) || lonNum < -180 || lonNum > 180) return "Longitude tidak valid (harus antara -180 dan 180)";
  return null;
};

const VALID_RADIUS = ["1km", "2km", "3km", "5km", "10km", "15km", "20km"];

const extractDriversFromResponse = (response) => {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.drivers)) return response.drivers;
  if (response.data && Array.isArray(response.data.drivers)) return response.data.drivers;
  if (response.data && Array.isArray(response.data.data)) return response.data.data;
  if (response.result && Array.isArray(response.result)) return response.result;
  if (response.data && typeof response.data === "object") {
    const nested = Object.values(response.data).find(v => Array.isArray(v));
    if (nested) return nested;
  }
  if (typeof response === "object") {
    const topLevel = Object.values(response).find(v => Array.isArray(v));
    if (topLevel) return topLevel;
  }
  return [];
};

const normalizeDriver = (d) => {
  const id = String(d.driver_id || d.id || d.driverId || d.driver?.id || "");
  if (!id) return null;
  const name = d.driver_name || d.name || d.driverName || d.driver?.name || "";
  const phone = d.driver_phone || d.phone || d.phone_number || d.phoneNumber || d.driver?.phone_number || "";
  const status = d.driver_status || d.status || d.driverStatus || d.driver?.status || "";
  const occupied = Boolean(d.is_occupied ?? d.occupied ?? d.isOccupied ?? false);
  const lat = parseFloat(d.latitude || d.lat || d.driver?.latitude || 0) || null;
  const lon = parseFloat(d.longitude || d.lon || d.long || d.driver?.longitude || 0) || null;
  const vendor = String(d.vendor_id || d.vendorId || d.vendor?.id || "");
  const rating = String(d.rating || d.driver?.rating || "");
  const businessIds = Array.isArray(d.business_ids)
    ? d.business_ids.map(String)
    : Array.isArray(d.businessIds)
    ? d.businessIds.map(String)
    : [];
  return { id, name, phone, status, occupied, lat, lon, vendor, rating, businessIds };
};

exports.getAll = async (req, res) => {
  try {
    const { status, radius, search, page = 1, limit = 25 } = req.query;
    const filter = {};
    if (status) filter.driver_status = status;
    if (radius) filter.radius = radius;
    if (search) {
      filter.$or = [
        { driver_name: new RegExp(search, "i") },
        { driver_phone: new RegExp(search, "i") },
        { driver_id: new RegExp(search, "i") },
      ];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [data, total] = await Promise.all([
      DeliveryMonitoring.find(filter).sort({ fetched_at: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      DeliveryMonitoring.countDocuments(filter),
    ]);
    res.json({ success: true, data, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: "Gagal mengambil data", error: err.message });
  }
};

exports.fetchAndSave = async (req, res) => {
  try {
    const { lat, lon, radius = "5km", should_include_all = true, vendor_id = [], business_ids = [] } = req.body;
    const validationError = validateCoordinate(lat, lon);
    if (validationError) return res.status(400).json({ success: false, message: validationError });
    if (!VALID_RADIUS.includes(radius)) return res.status(400).json({ success: false, message: "Radius tidak valid" });

    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);

    const response = await fetchDriversByCoordinate({
      lat: latNum, lon: lonNum, radius, should_include_all, vendor_id, business_ids,
    });

    const drivers = extractDriversFromResponse(response);

    if (!drivers.length) {
      return res.json({
        success: true,
        message: "Tidak ada driver ditemukan di koordinat ini",
        saved: 0,
        data: [],
        summary: { newDrivers: 0, existingDrivers: 0, total: 0 },
        debug: { responseKeys: response ? Object.keys(response) : [], responseType: typeof response },
      });
    }

    const normalizedDrivers = drivers.map(normalizeDriver).filter(Boolean);
    const incomingIds = normalizedDrivers.map(d => d.id);

    const existingDocs = await DeliveryMonitoring.find({ driver_id: { $in: incomingIds } }).select("driver_id").lean();
    const existingIdSet = new Set(existingDocs.map(d => d.driver_id));

    const newDriverIds = incomingIds.filter(id => !existingIdSet.has(id));
    const existingDriverIds = incomingIds.filter(id => existingIdSet.has(id));

    const now = new Date();

    await DeliveryMonitoring.updateMany(
      { driver_id: { $nin: incomingIds } },
      { $set: { is_new_on_last_fetch: false } }
    );

    const ops = normalizedDrivers.map((normalized) => {
      const isNew = !existingIdSet.has(normalized.id);
      return {
        updateOne: {
          filter: { driver_id: normalized.id },
          update: {
            $set: {
              driver_id: normalized.id,
              driver_name: normalized.name,
              driver_phone: normalized.phone,
              driver_status: normalized.status,
              is_occupied: normalized.occupied,
              latitude: normalized.lat,
              longitude: normalized.lon,
              vendor_id: normalized.vendor,
              rating: normalized.rating,
              business_ids: normalized.businessIds,
              radius,
              searched_coordinate: { lat: latNum, lon: lonNum },
              fetched_at: now,
              is_new_on_last_fetch: isNew,
            },
          },
          upsert: true,
        },
      };
    });

    const result = await DeliveryMonitoring.bulkWrite(ops, { ordered: false });

    const saved = await DeliveryMonitoring.find({ driver_id: { $in: incomingIds } })
      .sort({ fetched_at: -1 })
      .lean();

    res.json({
      success: true,
      message: `Berhasil memproses ${ops.length} data driver`,
      saved: ops.length,
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
      summary: {
        total: ops.length,
        newDrivers: newDriverIds.length,
        existingDrivers: existingDriverIds.length,
        newDriverIds,
      },
      data: saved,
    });
  } catch (err) {
    console.error("[DeliveryMonitoring] fetchAndSave error:", err);
    res.status(500).json({ success: false, message: "Gagal fetch driver location", error: err.message });
  }
};

exports.deleteOne = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await DeliveryMonitoring.findById(id);
    if (!doc) return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
    await DeliveryMonitoring.findByIdAndDelete(id);
    res.json({ success: true, message: "Data berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Gagal menghapus data", error: err.message });
  }
};

exports.loginBlitz = async (req, res) => {
  try {
    await login();
    res.json({ success: true, message: "Login ke RideBlitz berhasil" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Login gagal", error: err.message });
  }
};