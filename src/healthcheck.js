#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const healthPath = path.join(root, "data", "collector-health.json");
const maxAgeMs = Number(process.env.HEALTH_MAX_AGE_SECONDS || 120) * 1000;

try {
  const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  const age = Date.now() - Date.parse(health.updated_at);
  if (health.status !== "connected" || !Number.isFinite(age) || age > maxAgeMs) {
    throw new Error(`collector is ${health.status || "unknown"}; heartbeat age=${age}ms`);
  }
  console.log(`collector healthy; heartbeat age=${age}ms`);
} catch (error) {
  console.error(`collector unhealthy: ${error.message}`);
  process.exit(1);
}
