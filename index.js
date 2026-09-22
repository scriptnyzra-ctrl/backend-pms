require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const connectDB = require("./config/db");
const uploadRoutes = require("./routes/uploadRoutes");
const driverRoutes = require("./routes/driverRoutes");
const mitraRoutes = require("./routes/mitraRoutes");
const mitraExtendedRoutes = require("./routes/mitraExtendedRoutes");
const shipmentRoutes = require("./routes/shipmentRoutes");
const bonusRoutes = require("./routes/bonusRoutes");
const sayurboxRoutes = require("./routes/sayurboxRoutes");
const fleetRoutes = require("./routes/fleetRoutes");
const revenueRoutes = require("./routes/revenueRoutes");
const taskManagementRoutes = require("./routes/taskManagementRoutes");
const larkRoutes = require("./routes/larkRoutes");
const chartRoutes = require("./routes/chartRoutes");
const loginRoutes = require("./routes/loginRoutes");
const sellerRoutes = require("./routes/sellerRoutes");
const phoneMessageRoutes = require("./routes/phoneMessageRoutes");
const deliveryRoutes = require("./routes/deliveryRoutes.js");
const merchantOrderRoutes = require("./routes/merchantOrderRoutes.js");
const prospectPartnerRoutes = require("./routes/prospectPartnerRoutes");
const deliveryMonitoringRoutes = require("./routes/deliveryMonitoringRoutes");
const mitraAuthRoutes = require("./routes/mitraAuthRoutes.js");
const blitzSyncRoutes = require("./routes/blitzSyncRoutes.js");
const blitzProxyRoutes = require("./routes/blitzProxyRoutes.js");
const blitzLoginRoutes = require("./routes/blitzLoginRoutes.js");
const rideExperienceRoutes = require("./routes/rideExperienceRoutes.js");
const errorHandler = require("./middleware/errorHandler");
const chargedProxyRoutes = require("./routes/chargedProxyRoutes");
const { initializeLarkTokens } = require("./services/larkTokenService");
const validationRoutes = require("./routes/validationRoutes");

const app = express();
const port = process.env.PORT || 5000;

const WAHA_SERVICE_URL = process.env.WAHA_SERVICE_URL;

const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Cache-Control', 'X-Accel-Buffering', 'Accept', 'Pragma', 'Expires'],
  exposedHeaders: ['Content-Type', 'Cache-Control', 'X-Accel-Buffering'],
  credentials: false,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: false
}));

app.use(compression({
  filter: (req, res) => {
    if (req.path.includes('/manual-sync') || req.path.includes('/cancel-sync')) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

app.use(morgan("dev"));

app.use(express.json({ limit: "500mb", strict: false }));
app.use(express.urlencoded({ extended: true, limit: "500mb", parameterLimit: 100000 }));

app.use((req, res, next) => {
  const contentLength = req.headers['content-length'];
  if (contentLength && parseInt(contentLength) > 0) {
    const sizeMB = (parseInt(contentLength) / (1024 * 1024)).toFixed(2);
    if (parseFloat(sizeMB) > 10) {
      console.log(`📦 ${req.method} ${req.path} - Payload size: ${sizeMB}MB`);
    }
  }
  next();
});

app.use('/api/mitra/extended/manual-sync', (req, res, next) => {
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 1000);
  }
  next();
});

app.use("/api/auth", loginRoutes);
app.use("/api/mitra-auth", mitraAuthRoutes);
app.use("/api", uploadRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/mitra", mitraExtendedRoutes);
app.use("/api/mitra", mitraRoutes);
app.use("/api/shipment", shipmentRoutes);
app.use("/api/bonus", bonusRoutes);
app.use("/api/sayurbox", sayurboxRoutes);
app.use("/api/fleet", fleetRoutes);
app.use("/api/revenue", revenueRoutes);
app.use("/api/task-management", taskManagementRoutes);
app.use("/api/chart", chartRoutes);
app.use("/api", larkRoutes);
app.use("/api/seller", sellerRoutes);
app.use("/api/phone-message", phoneMessageRoutes);
app.use("/api/delivery", deliveryRoutes);
app.use("/api/merchant-orders", merchantOrderRoutes);
app.use("/api/prospect-partners", prospectPartnerRoutes);
app.use("/api/delivery-monitoring", deliveryMonitoringRoutes);
app.use("/api/blitz-sync", blitzSyncRoutes);
app.use("/api/blitz-proxy", blitzProxyRoutes);
app.use("/api/blitz-logins", blitzLoginRoutes);
app.use("/api/ride-experience", rideExperienceRoutes);
app.use("/api/validations", validationRoutes);
app.use("/api/charged-proxy", chargedProxyRoutes);

app.get("/api/health", async (req, res) => {
  try {
    let wahaHealth = "disconnected";
    let wahaStatus = "not_running";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${WAHA_SERVICE_URL}/api/server/status`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'x-api-key': process.env.WAHA_API_KEY
        },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) {
        wahaHealth = "connected";
        wahaStatus = "running_ok";
      } else if (response.status === 401) {
        wahaHealth = "connected";
        wahaStatus = "running_auth_required";
      }
    } catch (e) {
      wahaStatus = e.name === 'AbortError' ? "timeout" : "service_not_ready";
    }
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      waha: wahaHealth,
      wahaStatus: wahaStatus,
      wahaServiceUrl: WAHA_SERVICE_URL,
      note: wahaStatus === "running_auth_required" ? "WAHA is running and requires authentication" : undefined
    });
  } catch (error) {
    res.status(503).json({ status: "error", waha: "disconnected", error: error.message });
  }
});

app.get("/", (req, res) => {
  res.json({
    message: "PMS API Server is running",
    timestamp: new Date().toISOString(),
    bodyParserLimit: "500MB",
    maxParameters: 100000,
    wahaStatus: "integrated",
    wahaServiceUrl: WAHA_SERVICE_URL,
    wahaDashboard: `${WAHA_SERVICE_URL}/dashboard`,
    wahaSwagger: `${WAHA_SERVICE_URL}/`
  });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Request payload too large',
      error: 'Please apply filters to reduce dataset size (max: 500MB)',
      maxSize: '500MB',
      suggestion: 'Filter by Project, Hub, or Year to reduce data size'
    });
  }
  next(err);
});

app.use(errorHandler);

const startServer = async () => {
  try {
    await connectDB();
    console.log("✅ Database connected successfully");

    setTimeout(async () => {
      try {
        await initializeLarkTokens();
        console.log("✅ Lark tokens initialization completed");
      } catch (tokenError) {
        console.warn("⚠️ Lark token initialization failed:", tokenError.message);
      }
    }, 5000);

    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`\n🎉 Server running at http://localhost:${port}`);
    });

    server.setTimeout(0);
    server.keepAliveTimeout = 0;
    server.headersTimeout = 0;

  } catch (error) {
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();