const axios = require("axios");

const BLITZ_BASE_URL = "https://driver-api.rideblitz.id";
const LOCATION_BASE_URL = "https://location.rideblitz.id";
const CREDENTIALS = { username: "merapi", password: "qRKzNbami4" };

let cachedToken = null;

const login = async () => {
  const { data } = await axios.post(`${BLITZ_BASE_URL}/panel/login`, CREDENTIALS, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000,
  });

  console.log("[RideBlitz] Login response result:", data?.result);

  if (!data?.result || !data?.data?.access_token) {
    throw new Error("Token tidak ditemukan dalam response login");
  }

  cachedToken = data.data.access_token;
  console.log("[RideBlitz] Login berhasil, token disimpan");
  return cachedToken;
};

const getToken = async () => {
  if (cachedToken) return cachedToken;
  return login();
};

const fetchDriversByCoordinate = async ({
  lat,
  lon,
  radius,
  should_include_all = true,
  vendor_id = [],
  business_ids = [],
}) => {
  const token = await getToken();

  const payload = { lat, lon, radius, should_include_all, vendor_id, business_ids };

  console.log("[RideBlitz] Fetching drivers with payload:", JSON.stringify(payload));

  const doRequest = async (authToken) => {
    const { data } = await axios.post(
      `${LOCATION_BASE_URL}/get/driver`,
      payload,
      {
        headers: {
          authorization: authToken,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    return data;
  };

  try {
    const data = await doRequest(token);
    console.log("[RideBlitz] Response keys:", data ? Object.keys(data) : "null");
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log("[RideBlitz] Token expired, re-login...");
      cachedToken = null;
      const newToken = await login();
      const data = await doRequest(newToken);
      console.log("[RideBlitz] Retry response keys:", data ? Object.keys(data) : "null");
      return data;
    }
    console.error("[RideBlitz] Fetch error:", err.response?.status, err.message);
    throw err;
  }
};

const clearToken = () => {
  cachedToken = null;
};

module.exports = { login, getToken, fetchDriversByCoordinate, clearToken };