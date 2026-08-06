#!/usr/bin/env node
const host = process.env.HEALTH_HOST || "127.0.0.1";
const port = process.env.PORT || 3000;

try {
  const response = await fetch(`http://${host}:${port}/api/health`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const health = await response.json();
  if (health.ok !== true) throw new Error("health response was not ok");
  console.log("UI and database healthy");
} catch (error) {
  console.error(`UI unhealthy: ${error.message}`);
  process.exit(1);
}
