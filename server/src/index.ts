import { buildApp } from "./app.js";
import { config } from "./config.js";

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
