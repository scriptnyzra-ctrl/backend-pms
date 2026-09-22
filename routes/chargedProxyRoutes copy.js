const express = require("express");
const axios = require("axios");
const router = express.Router();

const BASE_URL = "https://bike-plat.fms-charged.co.id/plat/api/v1/v2";
const TENANT_ID = "1003";

let cachedToken = null;

const commonHeaders = (token) => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  tenantId: TENANT_ID,
  ...(token && {
    "plat-api-token": token,
    Authorization: `Bearer ${token}`,
    cookie: `plat-api-token=${token}`,
  }),
});

const chargedPost = async (path, body = {}, token = null) => {
  const res = await axios.post(`${BASE_URL}${path}`, body, {
    headers: commonHeaders(token),
    timeout: 15000,
  });
  return res.data;
};

const getToken = async () => {
  if (cachedToken) return cachedToken;
  const data = await chargedPost("/login/loginByPwd", {
    tenantId: TENANT_ID,
    account: "admin",
    userPwd: "admin",
  });
  if (data?.success && data?.data) {
    cachedToken = data.data;
    return cachedToken;
  }
  throw new Error("Login Charged gagal");
};

const invalidateToken = () => {
  cachedToken = null;
};

const withAuth = async (fn) => {
  try {
    const token = await getToken();
    return await fn(token);
  } catch (err) {
    if ([401, 403].includes(err?.response?.status)) {
      invalidateToken();
      const token = await getToken();
      return await fn(token);
    }
    throw err;
  }
};

router.post("/login", async (req, res) => {
  try {
    invalidateToken();
    const token = await getToken();
    const [userInfo, userMenu] = await Promise.all([
      chargedPost("/user/getUserInfo", {}, token),
      chargedPost("/user/getUserMenu", {}, token),
    ]);
    res.json({ success: true, token, userInfo: userInfo?.data, userMenu: userMenu?.data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/monitoring/page", async (req, res) => {
  try {
    const data = await withAuth((token) =>
      chargedPost("/cbf/getCarBaseInfoPage", req.body, token)
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/monitoring/detail/:vin", async (req, res) => {
  try {
    const { vin } = req.params;
    const data = await withAuth((token) =>
      chargedPost(`/cbf/getCarBaseInfoDetail/${vin}`, {}, token)
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/monitoring/batch", async (req, res) => {
  const { licensePlates } = req.body;
  console.log("Plates diterima dari frontend:", JSON.stringify(licensePlates));
  if (!Array.isArray(licensePlates) || licensePlates.length === 0) {
    return res.status(400).json({ success: false, message: "licensePlates harus array non-kosong" });
  }

  try {
    const token = await withAuth(async (t) => t);

    const monitoringResults = await Promise.allSettled(
      licensePlates.map((plate) =>
        chargedPost("/cbf/getCarBaseInfoPage", {
          deviceNo: "", vin: "", licensePlate: plate,
          carModelName: "", colorCode: "", tenantName: "",
          isOnline: "", motorNumber: "", pageNo: 1, pageSize: 20,
        }, token).then((d) => ({ plate, data: d?.data?.data?.[0] || null }))
      )
    );

    const monitoringMap = {};
    monitoringResults.forEach((r) => {
      if (r.status === "fulfilled") monitoringMap[r.value.plate] = r.value.data;
    });

    const vinEntries = Object.entries(monitoringMap).filter(([, car]) => car?.vin);
    const detailResults = await Promise.allSettled(
      vinEntries.map(([plate, car]) =>
        chargedPost(`/cbf/getCarBaseInfoDetail/${car.vin}`, {}, token)
          .then((d) => ({ plate, vin: car.vin, data: d?.data || null }))
      )
    );

    const detailMap = {};
    detailResults.forEach((r) => {
      if (r.status === "fulfilled") detailMap[r.value.plate] = r.value.data;
    });

    const result = {};
    licensePlates.forEach((plate) => {
      const monitoring = monitoringMap[plate] || null;
      result[plate] = monitoring ? { monitoring, detail: detailMap[plate] || null } : null;
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;