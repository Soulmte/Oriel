import { buildApp } from "./app.js";
import { config } from "./config.js";

// Packaged by the desktop app: stdin is a pipe held by Oriel. Losing it means
// the window is gone, so the service should not keep the port.
if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
}

const app = await buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `${config.appName} REST API listening on http://${config.host}:${config.port}/api`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
