"use strict";

const Sentry = require("@sentry/node");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: "https://669d6a8b82275ecf6221677cd0e4732e@o4510867115933696.ingest.de.sentry.io/4510867120521296",
    environment: process.env.NODE_ENV || "development",
    sendDefaultPii: true,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
  });
}
