"use strict";

const Wyze = require("wyze-api");
const mqtt = require("mqtt");
const fs = require("node:fs");

const required = ["WYZE_EMAIL", "WYZE_PASSWORD", "WYZE_KEY_ID", "WYZE_API_KEY", "MQTT_URL"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const intervalSeconds = Number.parseInt(process.env.POLL_INTERVAL_SECONDS || "30", 10);
if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10) {
  throw new Error("POLL_INTERVAL_SECONDS must be an integer of at least 10 seconds");
}

const wyzeDataPath = "/data/wyze";
fs.mkdirSync(wyzeDataPath, { recursive: true });

const discoveryPrefix = cleanPrefix(process.env.MQTT_DISCOVERY_PREFIX || "homeassistant");
const statePrefix = cleanPrefix(process.env.MQTT_STATE_PREFIX || "wyze");
const deviceModel = (process.env.DEVICE_MODEL || "DWS2U").trim().toUpperCase();
const clientId = process.env.MQTT_CLIENT_ID || "wyze-mqtt-bridge";

function cleanPrefix(value) {
  return value.replace(/^\/+|\/+$/g, "");
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

const wyze = new Wyze({
  username: process.env.WYZE_EMAIL,
  password: process.env.WYZE_PASSWORD,
  keyId: process.env.WYZE_KEY_ID,
  apiKey: process.env.WYZE_API_KEY,
  persistPath: wyzeDataPath,
  logLevel: "none",
});

const mqttOptions = {
  clientId,
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  clean: true,
  keepalive: 60,
  connectTimeout: 30_000,
  reconnectPeriod: 5_000,
  will: {
    topic: `${statePrefix}/bridge/availability`,
    payload: "offline",
    qos: 1,
    retain: true,
  },
};

const client = mqtt.connect(process.env.MQTT_URL, mqttOptions);
let stopping = false;
let pollInProgress = false;
let timer;
const knownDevices = new Map();

client.on("connect", () => {
  log("Connected to MQTT broker");
  publish(`${statePrefix}/bridge/availability`, "online", { retain: true }).catch(reportMqttError);
  for (const device of knownDevices.values()) publishDiscovery(device).catch(reportMqttError);
});
client.on("reconnect", () => log("MQTT reconnecting"));
client.on("offline", () => log("MQTT offline; waiting to reconnect"));
client.on("error", reportMqttError);

function reportMqttError(error) {
  // Do not print error objects: broker URLs and library errors can contain credentials.
  log(`MQTT error (${error && error.code ? error.code : "connection failure"})`);
}

function safeErrorCode(error) {
  return error && typeof error.code === "string" && /^[A-Z0-9_:-]{1,48}$/i.test(error.code)
    ? error.code
    : error && error.name === "TypeError" ? "TypeError" : "poll failure";
}

function publish(topic, payload, options = {}) {
  return new Promise((resolve, reject) => {
    if (!client.connected) return reject(new Error("MQTT disconnected"));
    client.publish(topic, String(payload), options, (error) => error ? reject(error) : resolve());
  });
}

function slug(value) {
  return String(value || "sensor").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "sensor";
}

function stableId(device) {
  return String(device.mac || device.mac_address || device.nickname || "unknown")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function deviceInfo(device) {
  const id = stableId(device);
  const name = String(device.nickname || `Wyze Contact ${id}`).trim();
  const objectId = `wyze_${slug(name)}_${id.slice(-8)}`;
  return {
    id,
    name,
    objectId,
    stateTopic: `${statePrefix}/contact/${id}/state`,
    availabilityTopic: `${statePrefix}/contact/${id}/availability`,
    mac: device.mac || device.mac_address || id,
    model: device.product_model || deviceModel,
  };
}

function deviceClassFor(device) {
  const name = String(device.nickname || "").toLowerCase();
  if (/\bgarage\b/.test(name) && /\bcar\b/.test(name)) return "garage_door";
  if (name.includes("window")) return "window";
  if (name.includes("door") || name.includes("refrigerator") || name.includes("fridge") || name.includes("freezer")) return "door";
  return "opening";
}

async function publishDiscovery(device) {
  const info = deviceInfo(device);
  const payload = {
    unique_id: info.objectId,
    default_entity_id: `binary_sensor.${slug(info.name)}`,
    state_topic: info.stateTopic,
    availability_topic: info.availabilityTopic,
    payload_on: "ON",
    payload_off: "OFF",
    payload_available: "online",
    payload_not_available: "offline",
    device_class: deviceClassFor(device),
    device: {
      identifiers: [`wyze_contact_${info.id}`],
      name: info.name,
      manufacturer: "Wyze",
      model: `Sense Contact Sensor v2 (${info.model})`,
    },
  };
  await publish(`${discoveryPrefix}/binary_sensor/${info.objectId}/config`, JSON.stringify(payload), { qos: 1, retain: true });
}

async function markUnavailable() {
  if (!client.connected) return;
  const messages = [publish(`${statePrefix}/bridge/availability`, "offline", { qos: 1, retain: true })];
  for (const device of knownDevices.values()) {
    messages.push(publish(deviceInfo(device).availabilityTopic, "offline", { qos: 1, retain: true }));
  }
  await Promise.allSettled(messages);
}

async function poll() {
  if (stopping || pollInProgress) return;
  pollInProgress = true;
  try {
    const devices = await wyze.getDeviceList();
    const contacts = devices.filter((device) => String(device.product_model || "").toUpperCase() === deviceModel);
    if (contacts.length === 0) throw new Error(`No ${deviceModel} devices returned`);

    const seen = new Set();
    for (const device of contacts) {
      const info = deviceInfo(device);
      seen.add(info.id);
      const isNewDevice = !knownDevices.has(info.id);
      knownDevices.set(info.id, device);
      const rawState = await wyze.getDeviceState(device);
      const state = String(rawState).trim().toLowerCase();
      if (state !== "open" && state !== "closed") {
        throw new Error("Unexpected sensor state");
      }
      if (isNewDevice) await publishDiscovery(device);
      await publish(info.stateTopic, state === "open" ? "ON" : "OFF", { qos: 1, retain: true });
      await publish(info.availabilityTopic, "online", { qos: 1, retain: true });
    }

    for (const [id, device] of knownDevices) {
      if (!seen.has(id)) await publish(deviceInfo(device).availabilityTopic, "offline", { qos: 1, retain: true });
    }
    await publish(`${statePrefix}/bridge/availability`, "online", { qos: 1, retain: true });
    log(`Polled ${contacts.length} ${deviceModel} contact sensor(s)`);
  } catch (error) {
    log(`Wyze poll failed (${safeErrorCode(error)})`);
    await markUnavailable();
  } finally {
    pollInProgress = false;
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  log(`Received ${signal}; shutting down`);
  const final = async () => {
    await markUnavailable();
    client.end(false, {}, () => process.exit(0));
  };
  const timeout = setTimeout(() => process.exit(0), 15_000);
  timeout.unref();
  final().catch(() => client.end(true, {}, () => process.exit(0)));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log(`Starting Wyze ${deviceModel} to MQTT bridge; poll interval ${intervalSeconds}s`);
poll();
timer = setInterval(poll, intervalSeconds * 1_000);

