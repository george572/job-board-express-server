require("dotenv").config();
const express = require("express");
const path = require("path");
const knex = require("knex");
const knexfile = require("./knexfile");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const compression = require("compression");

const environment = process.env.NODE_ENV || "development";
const db = knex(knexfile[environment]);

const app = express();
app.use(compression());

const port = process.env.PORT || 4000;

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const knexConfig = knexfile[environment];
const connection = knexConfig?.connection;
const sessionStore =
  process.env.DATABASE_URL
    ? new pgSession({
        conString: process.env.DATABASE_URL,
        tableName: "session",
        createTableIfMissing: true,
      })
    : connection
      ? new pgSession({
          conObject: typeof connection === "string" ? { connectionString: connection } : connection,
          tableName: "session",
          createTableIfMissing: true,
        })
      : undefined;

app.use(
  session({
    store: sessionStore,
    resave: false,
    secret: process.env.SESSION_SECRET || "askmdaksdhjkqjqkqkkq1",
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/fonts", express.static(path.join(__dirname, "public/fonts"), {
  maxAge: "365d",
  immutable: true,
}));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "7d" }));

const hrRouter = require("./routes/hrDashboard")(db);
app.use(hrRouter);

app.listen(port, () => {
  console.log(`HR Dashboard running at http://localhost:${port}`);
});
