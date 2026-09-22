const XLSX = require("xlsx");
const PhoneMessage = require("../models/PhoneMessage");
const MessageLog = require("../models/MessageLog");

const WAHA_SERVICE_URL = process.env.WAHA_SERVICE_URL;
const WAHA_API_KEY = process.env.WAHA_API_KEY;

const MAX_BATCH_SIZE = 30;
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;
const MIN_MESSAGE_DELAY = 30000;
const MAX_MESSAGE_DELAY = 60000;
const REQUEST_TIMEOUT = 30000;
const TYPING_DELAY_PER_CHAR = 50;
const MIN_TYPING_DELAY = 2000;
const MAX_TYPING_DELAY = 8000;

function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/\D/g, "").trim();
  if (!cleaned) return null;

  if (cleaned.startsWith("62")) {
  } else if (cleaned.startsWith("0")) {
    cleaned = "62" + cleaned.slice(1);
  } else if (cleaned.startsWith("8")) {
    cleaned = "62" + cleaned;
  } else {
    cleaned = "62" + cleaned;
  }

  if (cleaned.length < 10 || cleaned.length > 15) return null;
  return cleaned;
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function calculateTypingDelay(message) {
  const baseDelay = Math.min(message.length * TYPING_DELAY_PER_CHAR, MAX_TYPING_DELAY);
  return Math.max(baseDelay, MIN_TYPING_DELAY);
}

function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Request timeout")), timeout)),
  ]);
}

async function sendSeen(chatId) {
  try {
    await fetchWithTimeout(
      `${WAHA_SERVICE_URL}/api/sendSeen`,
      {
        method: "POST",
        headers: { "x-api-key": WAHA_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, session: "default" }),
      },
      10000
    );
  } catch (error) {
    console.warn(`Failed to send seen for ${chatId}:`, error.message);
  }
}

async function startTyping(chatId) {
  try {
    await fetchWithTimeout(
      `${WAHA_SERVICE_URL}/api/startTyping`,
      {
        method: "POST",
        headers: { "x-api-key": WAHA_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, session: "default" }),
      },
      10000
    );
  } catch (error) {
    console.warn(`Failed to start typing for ${chatId}:`, error.message);
  }
}

async function stopTyping(chatId) {
  try {
    await fetchWithTimeout(
      `${WAHA_SERVICE_URL}/api/stopTyping`,
      {
        method: "POST",
        headers: { "x-api-key": WAHA_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, session: "default" }),
      },
      10000
    );
  } catch (error) {
    console.warn(`Failed to stop typing for ${chatId}:`, error.message);
  }
}

async function verifyMessageDelivery(messageId, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetchWithTimeout(
        `${WAHA_SERVICE_URL}/api/messages/${messageId}`,
        { method: "GET", headers: { "x-api-key": WAHA_API_KEY, Accept: "application/json" } },
        10000
      );
      if (response.ok) {
        const data = await response.json();
        return { verified: true, status: data.ack || data.status || "unknown", data };
      }
    } catch {
      if (i === retries - 1) return { verified: false, status: "verification_failed" };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { verified: false, status: "verification_failed" };
}

async function sendWhatsAppMessageWithHumanBehavior(phone, message, retryCount = 0) {
  const chatId = `${phone}@c.us`;

  try {
    await sendSeen(chatId);
    await new Promise((r) => setTimeout(r, getRandomDelay(500, 1500)));
    await startTyping(chatId);
    await new Promise((r) => setTimeout(r, calculateTypingDelay(message)));
    await stopTyping(chatId);
    await new Promise((r) => setTimeout(r, getRandomDelay(300, 800)));

    console.log(`[SEND] Attempting to send to ${phone} (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);

    const response = await fetchWithTimeout(
      `${WAHA_SERVICE_URL}/api/sendText`,
      {
        method: "POST",
        headers: {
          "x-api-key": WAHA_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ chatId, text: message, session: "default" }),
      },
      45000
    );

    console.log(`[RESPONSE] Status ${response.status} for ${phone}`);

    let responseData;
    try {
      responseData = await response.json();
    } catch (parseError) {
      if (response.status >= 200 && response.status < 300) {
        return { success: true, data: { status: "assumed_success" }, messageId: "parse_error_but_ok", verified: false, deliveryStatus: "unknown" };
      }
      throw new Error(`Response parse error: ${parseError.message}`);
    }

    if ((response.status >= 200 && response.status < 300) || responseData.id || responseData.messageId) {
      await new Promise((r) => setTimeout(r, 2000));
      let messageId = responseData.id || responseData.messageId;
      if (messageId && typeof messageId === "object") {
        messageId = messageId.id || messageId._serialized || JSON.stringify(messageId);
      }
      let verificationResult = { verified: false };
      if (messageId && typeof messageId === "string") {
        verificationResult = await verifyMessageDelivery(messageId);
      }
      return { success: true, data: responseData, messageId: messageId || "unknown", verified: verificationResult.verified, deliveryStatus: verificationResult.status };
    }

    const errorMessage = responseData.message || responseData.error || "";
    const isNotRegistered =
      response.status === 404 ||
      errorMessage.toLowerCase().includes("participant not found") ||
      errorMessage.toLowerCase().includes("jid not found") ||
      errorMessage.toLowerCase().includes("not exists");

    if (isNotRegistered) {
      return { success: false, error: "Number not registered on WhatsApp", code: "NOT_REGISTERED", data: responseData, shouldRetry: false, isNotRegistered: true };
    }

    if (response.status === 429 && retryCount < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY * (retryCount + 2)));
      return sendWhatsAppMessageWithHumanBehavior(phone, message, retryCount + 1);
    }

    if (response.status >= 500 && retryCount < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY * (retryCount + 1)));
      return sendWhatsAppMessageWithHumanBehavior(phone, message, retryCount + 1);
    }

    if (response.status === 401 || response.status === 403) {
      return { success: false, error: "WhatsApp session not authenticated. Please scan QR code.", code: "SESSION_UNAUTHORIZED", data: responseData, shouldRetry: false };
    }

    return { success: false, error: responseData.message || responseData.error || `HTTP ${response.status}`, code: response.status.toString(), data: responseData, shouldRetry: response.status >= 500 || response.status === 429 };
  } catch (error) {
    const isRetryable = error.message === "Request timeout" || error.code === "ETIMEDOUT" || error.code === "ECONNRESET";
    if (retryCount < MAX_RETRIES && isRetryable) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY * (retryCount + 1)));
      return sendWhatsAppMessageWithHumanBehavior(phone, message, retryCount + 1);
    }
    return { success: false, error: error.message, code: error.code || "NETWORK_ERROR", shouldRetry: isRetryable && retryCount < MAX_RETRIES };
  }
}

exports.uploadExcel = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(worksheet);

    if (!data.length) return res.status(400).json({ success: false, message: "Excel file is empty" });

    const phoneMessages = data
      .map((row) => ({ phone: row.phone || row.Phone || "", message: row.message || row.Message || "", deliveryStatus: "pending" }))
      .filter((item) => item.phone && item.message);

    if (!phoneMessages.length) return res.status(400).json({ success: false, message: "No valid phone and message data found in Excel" });

    await PhoneMessage.deleteMany({});
    await MessageLog.deleteMany({});
    const result = await PhoneMessage.insertMany(phoneMessages);

    res.json({
      success: true,
      message: `Successfully uploaded ${result.length} records`,
      count: result.length,
      warning: "⚠️ IMPORTANT: Use SAFE MODE to avoid account restrictions. Send max 20-30 messages per hour with breaks.",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to upload Excel file", error: error.message });
  }
};

exports.getAllMessages = async (req, res) => {
  try {
    const messages = await PhoneMessage.find().sort({ uploadedAt: -1 });
    res.json({ success: true, count: messages.length, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch messages", error: error.message });
  }
};

exports.deleteAllMessages = async (req, res) => {
  try {
    await PhoneMessage.deleteMany({});
    await MessageLog.deleteMany({});
    res.json({ success: true, message: "All messages and logs deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete messages", error: error.message });
  }
};

exports.sendMessages = async (req, res) => {
  try {
    const { v4: uuidv4 } = await import("uuid");
    const { customMessage, safeMode = true, messagesPerBatch = 20, contacts, source } = req.body;

    const batchSize = parseInt(messagesPerBatch);
    if (isNaN(batchSize) || batchSize < 1) {
      return res.status(400).json({ success: false, message: "Jumlah batch tidak valid (minimal 1)." });
    }
    if (batchSize > MAX_BATCH_SIZE) {
      return res.status(400).json({ success: false, message: `Jumlah batch melebihi batas maksimal ${MAX_BATCH_SIZE}. Kurangi jumlah pesan per batch.` });
    }

    const isDriverSource = source === "delivery_monitoring" && Array.isArray(contacts) && contacts.length > 0;

    let messagesToSend = [];

    if (isDriverSource) {
      const validContacts = contacts.filter((c) => {
        const normalized = normalizePhone(c.phone);
        return normalized !== null;
      });

      if (!validContacts.length) {
        return res.status(400).json({ success: false, message: "Tidak ada kontak driver dengan nomor telepon valid." });
      }

      if (!customMessage || !customMessage.trim()) {
        return res.status(400).json({ success: false, message: "Pesan tidak boleh kosong saat menggunakan kontak dari Delivery Monitoring." });
      }

      const processedPhones = await MessageLog.find({ status: { $in: ["success", "failed"] } }).distinct("normalizedPhone");
      const processedSet = new Set(processedPhones);

      messagesToSend = validContacts
        .map((c) => {
          const normalized = normalizePhone(c.phone);
          return normalized ? { phone: c.phone, normalizedPhone: normalized, message: customMessage.trim(), _id: null } : null;
        })
        .filter((c) => c !== null && !processedSet.has(c.normalizedPhone));
    } else {
      await PhoneMessage.updateMany({ deliveryStatus: { $exists: false } }, { $set: { deliveryStatus: "pending" } });

      const processedPhones = await MessageLog.find({ status: { $in: ["success", "failed"] } }).distinct("normalizedPhone");
      const processedSet = new Set(processedPhones);

      const allMessages = await PhoneMessage.find().sort({ uploadedAt: -1 });
      messagesToSend = allMessages
        .map((msg) => {
          const normalized = normalizePhone(msg.phone);
          return normalized ? { phone: msg.phone, normalizedPhone: normalized, message: msg.message, _id: msg._id } : null;
        })
        .filter((m) => m !== null && !processedSet.has(m.normalizedPhone));
    }

    if (!messagesToSend.length) {
      return res.status(400).json({ success: false, message: "No pending messages found. All contacts have been processed (either SENT or FAILED)." });
    }

    if (!safeMode && messagesToSend.length > 50) {
      return res.status(400).json({ success: false, message: "⚠️ UNSAFE MODE blocked for bulk sending. Use SAFE MODE to prevent account restriction." });
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const batchId = uuidv4();
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let processedCount = 0;

    const sendProgress = (data) => res.write(JSON.stringify(data) + "\n");

    const totalToSend = safeMode ? Math.min(messagesToSend.length, batchSize) : messagesToSend.length;

    sendProgress({ type: "start", total: totalToSend, batchId, safeMode });

    const messagesToProcess = messagesToSend.slice(0, totalToSend);

    for (const msg of messagesToProcess) {
      const normalizedPhone = msg.normalizedPhone;
      const textToSend = customMessage && customMessage.trim() ? customMessage.trim() : msg.message;

      const existingLog = await MessageLog.findOne({ normalizedPhone }).sort({ createdAt: -1 });
      if (existingLog && (existingLog.status === "success" || existingLog.status === "failed")) {
        skippedCount++;
        processedCount++;
        sendProgress({ type: "progress", phone: normalizedPhone, status: "skipped", processed: processedCount, total: totalToSend, successCount, failedCount, skippedCount });
        continue;
      }

      sendProgress({ type: "progress", phone: normalizedPhone, status: "sending", processed: processedCount, total: totalToSend, successCount, failedCount, skippedCount });

      const sendResult = await sendWhatsAppMessageWithHumanBehavior(normalizedPhone, textToSend);

      if (sendResult.success) {
        let wahaMessageId = sendResult.messageId;
        if (wahaMessageId && typeof wahaMessageId === "object") {
          wahaMessageId = wahaMessageId.id || wahaMessageId._serialized || "object_type";
        }

        try {
          await MessageLog.create({
            phone: msg.phone,
            normalizedPhone,
            message: textToSend,
            status: "success",
            attempts: 1,
            lastAttemptAt: new Date(),
            successAt: new Date(),
            isWhatsAppRegistered: true,
            batchId,
            wahaResponse: sendResult.data,
            wahaMessageId: wahaMessageId || "unknown",
            actualDeliveryStatus: sendResult.deliveryStatus,
          });

          if (msg._id) {
            await PhoneMessage.updateOne({ _id: msg._id }, { $set: { deliveryStatus: "sent" } });
          }

          successCount++;
        } catch (logError) {
          console.error(`[LOG_ERROR] ${normalizedPhone}:`, logError.message);
          await MessageLog.create({ phone: msg.phone, normalizedPhone, message: textToSend, status: "success", attempts: 1, lastAttemptAt: new Date(), successAt: new Date(), isWhatsAppRegistered: true, batchId, wahaResponse: null, wahaMessageId: "log_error", actualDeliveryStatus: "unknown" });
          successCount++;
        }

        processedCount++;
        sendProgress({ type: "progress", phone: normalizedPhone, status: "success", processed: processedCount, total: totalToSend, successCount, failedCount, skippedCount, messageId: wahaMessageId });
      } else {
        const isSessionError = sendResult.code === "SESSION_UNAUTHORIZED" || sendResult.code === "401" || sendResult.code === "403";
        const isNotRegistered = sendResult.isNotRegistered === true || sendResult.code === "NOT_REGISTERED";
        const errorReason = sendResult.error || "Unknown error";
        const errorCode = sendResult.code || "UNKNOWN";

        try {
          await MessageLog.create({
            phone: msg.phone,
            normalizedPhone,
            message: textToSend,
            status: "failed",
            attempts: 1,
            lastAttemptAt: new Date(),
            errorMessage: errorReason,
            errorCode,
            isWhatsAppRegistered: isNotRegistered ? false : null,
            batchId,
            wahaResponse: sendResult.data,
          });

          if (msg._id) {
            await PhoneMessage.updateOne({ _id: msg._id }, { $set: { deliveryStatus: "failed" } });
          }

          failedCount++;
        } catch (logError) {
          console.error(`[LOG_ERROR] ${normalizedPhone}:`, logError.message);
          await MessageLog.create({ phone: msg.phone, normalizedPhone, message: textToSend, status: "failed", attempts: 1, lastAttemptAt: new Date(), errorMessage: `Log save error: ${logError.message}`, errorCode: "LOG_ERROR", isWhatsAppRegistered: null, batchId, wahaResponse: null });
          failedCount++;
        }

        processedCount++;
        sendProgress({ type: "progress", phone: normalizedPhone, status: "failed", error: errorReason, errorCode, processed: processedCount, total: totalToSend, successCount, failedCount, skippedCount });

        if (isSessionError) {
          sendProgress({ type: "error", error: "⚠️ CRITICAL: WhatsApp session not authenticated. Please scan QR code in WAHA Controls section and retry.", stopBatch: true });
          break;
        }
      }

      if (processedCount < totalToSend) {
        const delay = safeMode ? getRandomDelay(MIN_MESSAGE_DELAY, MAX_MESSAGE_DELAY) : getRandomDelay(3000, 5000);
        sendProgress({ type: "waiting", phone: normalizedPhone, delay: Math.floor(delay / 1000) });
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    const remainingMessages = messagesToSend.length - totalToSend;
    const recommendation =
      remainingMessages > 0
        ? `⏰ ${remainingMessages} messages remaining. Wait 1 hour before sending next batch to avoid restrictions.`
        : "✅ All pending messages processed.";

    sendProgress({ type: "complete", batchId, total: totalToSend, successCount, failedCount, skippedCount, remainingMessages, message: `Completed: ${successCount} sent, ${failedCount} failed (permanent), ${skippedCount} skipped`, recommendation });

    res.end();
  } catch (error) {
    console.error("Send messages error:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Failed to send messages", error: error.message });
    } else {
      res.write(JSON.stringify({ type: "error", error: error.message }) + "\n");
      res.end();
    }
  }
};

exports.getMessageLogs = async (req, res) => {
  try {
    const { status, batchId } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (batchId) filter.batchId = batchId;
    const logs = await MessageLog.find(filter).sort({ createdAt: -1 }).limit(1000);
    res.json({ success: true, count: logs.length, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch message logs", error: error.message });
  }
};

exports.exportMessageLogs = async (req, res) => {
  try {
    const { batchId } = req.query;
    const filter = batchId ? { batchId } : {};
    const logs = await MessageLog.find(filter).sort({ createdAt: -1 });

    const exportData = logs.map((log) => ({
      "Phone Number": log.phone,
      "Normalized Phone": log.normalizedPhone,
      Message: log.message,
      Status: log.status.toUpperCase(),
      Attempts: log.attempts,
      "WhatsApp Registered": log.isWhatsAppRegistered === null ? "Unknown" : log.isWhatsAppRegistered ? "Yes" : "No",
      "Error Message": log.errorMessage || "-",
      "Error Code": log.errorCode || "-",
      "Last Attempt": log.lastAttemptAt ? new Date(log.lastAttemptAt).toLocaleString() : "-",
      "Success Time": log.successAt ? new Date(log.successAt).toLocaleString() : "-",
      "Batch ID": log.batchId,
      "Message ID": log.wahaMessageId || "-",
      "Delivery Status": log.actualDeliveryStatus || "-",
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Message Logs");
    const excelBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=message-logs-${Date.now()}.xlsx`);
    res.send(excelBuffer);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to export message logs", error: error.message });
  }
};

exports.getStatistics = async (req, res) => {
  try {
    const { batchId } = req.query;
    const filter = batchId ? { batchId } : {};
    const stats = await MessageLog.aggregate([{ $match: filter }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
    const result = { total: 0, success: 0, failed: 0, pending: 0 };
    stats.forEach((s) => { result[s._id] = s.count; result.total += s.count; });
    const latestBatch = await MessageLog.findOne(filter).sort({ createdAt: -1 });
    res.json({ success: true, statistics: result, latestBatchId: latestBatch ? latestBatch.batchId : null });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch statistics", error: error.message });
  }
};