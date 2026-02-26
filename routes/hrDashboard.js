const crypto = require("crypto");
const express = require("express");
const router = express.Router();

const SALT_BYTES = 16;
const KEY_LEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_OPTIONS);
  return salt.toString("hex") + ":" + hash.toString("hex");
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = function (db) {
  // GET /hr – default: redirect to auth or dashboard
  router.get("/", (req, res) => {
    if (req.session.hrUser) return res.redirect("/hr/dashboard");
    res.redirect("/hr/auth");
  });

  // GET /hr/auth/back – clear company, go back to step 1 (enter new identification number)
  router.get("/auth/back", (req, res) => {
    delete req.session.hrRegistration;
    res.redirect("/hr/auth");
  });

  // GET /hr/auth – step 1 (company ID), step login (password only), or step register (email + passwords)
  router.get("/auth", async (req, res) => {
    if (req.session.hrUser) return res.redirect("/hr/dashboard");
    const companyIdentifier = req.session.hrRegistration?.company_identifier;
    if (companyIdentifier) {
      const existing = await db("hr_accounts")
        .where({ company_identifier: companyIdentifier })
        .select("id")
        .first();
      const step = existing ? "login" : "register";
      return res.render("hr/auth", {
        seo: { title: step === "login" ? "HR შესვლა - Samushao.ge" : "HR რეგისტრაცია - Samushao.ge", description: "HR ავტორიზაცია" },
        step,
        company_identifier: companyIdentifier,
        error: req.session.hrRegistration?.error || null,
      });
    }
    res.render("hr/auth", {
      seo: { title: "HR ავტორიზაცია - Samushao.ge", description: "HR ავტორიზაცია" },
      step: "step1",
      error: req.session.hrRegistration?.error || null,
    });
  });

  // POST /hr/auth/validate-company – mock rs.ge lookup; on success save session and return ok
  router.post("/auth/validate-company", async (req, res) => {
    const company_identifier = (req.body.company_identifier || "").trim();
    if (!company_identifier) {
      return res.status(400).json({
        ok: false,
        error: "company identifier is not able to be retrieved by rs.ge",
      });
    }
    // Mock delay simulating request to rs.ge
    await new Promise((r) => setTimeout(r, 800));
    // Mock: treat as not found for specific values (replace with real rs.ge API when ready)
    const notFoundValues = ["0", "000", "000000000", "invalid", "notfound", "fail"];
    const isNotFound =
      notFoundValues.includes(company_identifier.toLowerCase()) ||
      /fail/i.test(company_identifier);
    if (isNotFound) {
      return res.status(200).json({
        ok: false,
        error: "company identifier is not able to be retrieved by rs.ge",
      });
    }
    const existing = await db("hr_accounts")
      .where({ company_identifier })
      .select("id")
      .first();
    req.session.hrRegistration = { company_identifier };
    delete req.session.hrRegistration?.error;
    res.status(200).json({ ok: true, existing: !!existing });
  });

  // POST /hr/auth/step1 – save company identifier, show login or register (fallback for no-JS)
  router.post("/auth/step1", async (req, res) => {
    const company_identifier = (req.body.company_identifier || "").trim();
    if (!company_identifier) {
      req.session.hrRegistration = { error: "კომპანიის საიდენტიფიკაციო აუცილებელია." };
      return res.redirect("/hr/auth");
    }
    req.session.hrRegistration = { company_identifier };
    delete req.session.hrRegistration?.error;
    res.redirect("/hr/auth");
  });

  // POST /hr/auth/login – existing company: validate password, set session, redirect to dashboard
  router.post("/auth/login", async (req, res) => {
    const company_identifier =
      (req.body.company_identifier || "").trim() ||
      req.session.hrRegistration?.company_identifier ||
      "";
    const password = req.body.password;
    if (!company_identifier) {
      req.session.hrRegistration = { error: "კომპანიის საიდენტიფიკაციო აუცილებელია." };
      return res.redirect("/hr/auth");
    }
    if (!password || password.length < 6) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "პაროლი მინიმუმ 6 სიმბოლო." };
      return res.redirect("/hr/auth");
    }
    const account = await db("hr_accounts")
      .where({ company_identifier })
      .select("id", "email", "company_identifier", "password_hash")
      .first();
    if (!account || !verifyPassword(password, account.password_hash)) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "არასწორი პაროლი." };
      return res.redirect("/hr/auth");
    }
    req.session.hrUser = {
      id: account.id,
      email: account.email,
      company_identifier: account.company_identifier,
    };
    delete req.session.hrRegistration;
    return res.redirect("/hr/dashboard");
  });

  // POST /hr/auth/register – new company: email + password, save to hr_accounts, redirect to dashboard
  router.post("/auth/register", async (req, res) => {
    const company_identifier =
      (req.body.company_identifier || "").trim() ||
      req.session.hrRegistration?.company_identifier ||
      "";
    if (!company_identifier) {
      req.session.hrRegistration = { error: "პირველად შეიყვანეთ კომპანიის საიდენტიფიკაციო." };
      return res.redirect("/hr/auth");
    }
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password;
    const repeat_password = req.body.repeat_password;

    if (!email) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "ელფოსტა აუცილებელია." };
      return res.redirect("/hr/auth");
    }
    if (!password || password.length < 6) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "პაროლი მინიმუმ 6 სიმბოლო." };
      return res.redirect("/hr/auth");
    }
    if (password !== repeat_password) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "პაროლები არ ემთხვევა." };
      return res.redirect("/hr/auth");
    }

    try {
      const inserted = await db("hr_accounts")
        .insert({
          company_identifier,
          email,
          password_hash: hashPassword(password),
        })
        .returning(["id", "email", "company_identifier"]);
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      req.session.hrUser = {
        id: row?.id,
        email: row?.email ?? email,
        company_identifier: row?.company_identifier ?? company_identifier,
      };
      delete req.session.hrRegistration;
      return res.redirect("/hr/dashboard");
    } catch (err) {
      if (err.code === "23505") {
        req.session.hrRegistration = { ...req.session.hrRegistration, error: "ამ საიდენტიფიკაციო ნომრით უკვე დარეგისტრირებულია." };
      } else {
        console.error("hr/register error:", err);
        req.session.hrRegistration = { ...req.session.hrRegistration, error: "შეცდომა. სცადეთ თავიდან." };
      }
      return res.redirect("/hr/auth");
    }
  });

  // GET /hr/dashboard – actual dashboard (logged-in only)
  router.get("/dashboard", async (req, res) => {
    if (!req.session.hrUser) return res.redirect("/hr/auth");
    return res.render("hr/dashboard", {
      seo: { title: "HR Dashboard - Samushao.ge", description: "HR dashboard" },
      hrUser: req.session.hrUser,
    });
  });

  // POST /hr/dashboard/logout
  router.post("/dashboard/logout", (req, res) => {
    delete req.session.hrUser;
    delete req.session.hrRegistration;
    res.redirect("/hr/auth");
  });

  return router;
};
