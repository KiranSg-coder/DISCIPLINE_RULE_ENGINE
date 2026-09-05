const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { EVENT_TYPES, EVENT_CATEGORIES } = require("../config/eventTypes");

const EVENT_BUS_URL = (process.env.EVENT_BUS_URL || "http://localhost:6007").replace(/\/$/, "");
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;

class EventPublisher {
  async publish(eventType, eventCategory, payload, metadata = {}) {
    try {
      const event = {
        eventType,
        eventCategory,
        sourceSystem: "DISCIPLINE_RULE_ENGINE",
        userId: payload.userId || null,
        entityType: metadata.entityType || null,
        entityId: metadata.entityId || null,
        payload,
        metadata,
        correlationId: uuidv4(),
      };

      console.log(`[RuleEngine EventPublisher] 📤 ${eventType}`);

      const response = await axios.post(`${EVENT_BUS_URL}/event/publish`, event, {
        headers: {
          "Content-Type": "application/json",
          "X-Service-Key": SERVICE_KEY,
        },
        timeout: 5000,
      });

      return response.data?.data;
    } catch (err) {
      console.error(`[RuleEngine EventPublisher] ❌ ${eventType}:`, err.message);
      return null;
    }
  }
}

module.exports = new EventPublisher();