const crypto = require("crypto");
const nodemailer = require("nodemailer");

const HR_SEARCH_COOKIE = "hr_search_token";
const HR_SEARCH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCookie(req, name) {
  const raw = req?.headers?.cookie || "";
  const match = raw.match(new RegExp("\\b" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[1].trim()) : null;
}
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

const SKIP_HR_AUTH = process.env.HR_SKIP_AUTH === "1";

function formatCreditsForDisplay(val) {
  if (val == null || val === "") return "0";
  // Preserve string from DB (e.g. "94.5") and handle pg Decimal-like objects
  const str = typeof val === "object" && val !== null && typeof val.toString === "function"
    ? val.toString()
    : String(val);
  const n = parseFloat(str);
  if (Number.isNaN(n)) return "0";
  return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1);
}

module.exports = function (db) {
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error((label || "operation") + " timed out after " + ms + "ms")), ms)
      ),
    ]);
  }

  // GET / – default: redirect to auth or dashboard (or dashboard if HR_SKIP_AUTH)
  router.get("/", (req, res) => {
    if (SKIP_HR_AUTH || req.session.hrUser) return res.redirect("/dashboard");
    res.redirect("/auth");
  });

  // GET /auth/back – clear company, go back to step 1 (enter new identification number)
  router.get("/auth/back", (req, res) => {
    delete req.session.hrRegistration;
    res.redirect("/auth");
  });

  // GET /auth – signin (email+password first), step 1 (company ID), step login (password only), or step register (email + passwords)
  router.get("/auth", async (req, res) => {
    if (SKIP_HR_AUTH || req.session.hrUser) return res.redirect("/dashboard");
    const companyIdentifier = req.session.hrRegistration?.company_identifier;
    if (companyIdentifier) {
      const existing = await db("hr_accounts")
        .where({ company_identifier: companyIdentifier })
        .select("id")
        .first();
      const step = existing ? "login" : "register";
      const company_name = req.session.hrRegistration?.company_name || companyIdentifier;
      return res.render("hr/auth", {
        seo: { title: step === "login" ? "HR შესვლა - Samushao.ge" : "HR რეგისტრაცია - Samushao.ge", description: "HR ავტორიზაცია" },
        step,
        company_identifier: companyIdentifier,
        company_name,
        error: req.session.hrRegistration?.error || null,
      });
    }
    // Initial view: sign in with email+password, or go to registration (step1 = company ID)
    const showRegister = req.query.step === "step1";
    res.render("hr/auth", {
      seo: { title: showRegister ? "HR რეგისტრაცია - Samushao.ge" : "HR შესვლა - Samushao.ge", description: "HR ავტორიზაცია" },
      step: showRegister ? "step1" : "signin",
      error: req.session.hrRegistration?.error || null,
    });
  });

  async function getCompanyByTaxId(taxId) {
    const url = "https://xdata.rs.ge/TaxPayer/RSPublicInfo";
    const payload = { IdentCode: taxId.toString() };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data;
    } catch (error) {
      console.error("Failed to fetch company by tax ID:", error);
      return null;
    }
  }

  const COMPANY_NOT_FOUND_MSG =
    "ამ საიდენტიფიკაციო კოდით ვერ ვიპოვეთ კომპანია, სცადეთ თავიდან ან დაგვეკონტაქტეთ info@samushao.ge";

  const COMPANY_ALREADY_REGISTERED_MSG = "ეს კომპანია უკვე დარეგისტრირებულია";

  // POST /auth/validate-company – rs.ge lookup; on success save session and return ok
  router.post("/auth/validate-company", async (req, res) => {
    const company_identifier = (req.body.company_identifier || "").trim();
    if (!company_identifier) {
      return res.status(400).json({
        ok: false,
        error: COMPANY_NOT_FOUND_MSG,
      });
    }
    const companyData = await getCompanyByTaxId(company_identifier);
    // API returns array: valid = [{ FullName, Status, ... }], not found = [] or [{}]
    const isValid =
      Array.isArray(companyData) &&
      companyData.length > 0 &&
      companyData[0] &&
      typeof companyData[0] === "object" &&
      (companyData[0].FullName || companyData[0].Status || companyData[0].RegisteredSubject);
    if (!isValid) {
      return res.status(200).json({
        ok: false,
        error: COMPANY_NOT_FOUND_MSG,
      });
    }
    const existing = await db("hr_accounts")
      .where({ company_identifier })
      .select("id")
      .first();
    if (existing) {
      return res.status(200).json({
        ok: false,
        error: COMPANY_ALREADY_REGISTERED_MSG,
      });
    }
    const company_name =
      (companyData[0] && (companyData[0].FullName || companyData[0].RegisteredSubject)) || company_identifier;
    req.session.hrRegistration = { company_identifier, company_name };
    delete req.session.hrRegistration?.error;
    res.status(200).json({ ok: true, existing: false });
  });

  // POST /auth/step1 – save company identifier, show login or register (fallback for no-JS)
  router.post("/auth/step1", async (req, res) => {
    const company_identifier = (req.body.company_identifier || "").trim();
    if (!company_identifier) {
      req.session.hrRegistration = { error: "კომპანიის საიდენტიფიკაციო აუცილებელია." };
      return res.redirect("/auth");
    }
    const companyData = await getCompanyByTaxId(company_identifier);
    const isValid =
      Array.isArray(companyData) &&
      companyData.length > 0 &&
      companyData[0] &&
      typeof companyData[0] === "object" &&
      (companyData[0].FullName || companyData[0].Status || companyData[0].RegisteredSubject);
    if (!isValid) {
      req.session.hrRegistration = { error: COMPANY_NOT_FOUND_MSG };
      return res.redirect("/auth");
    }
    const existing = await db("hr_accounts")
      .where({ company_identifier })
      .select("id")
      .first();
    if (existing) {
      req.session.hrRegistration = { error: COMPANY_ALREADY_REGISTERED_MSG };
      return res.redirect("/auth");
    }
    const company_name =
      (companyData[0] && (companyData[0].FullName || companyData[0].RegisteredSubject)) || company_identifier;
    req.session.hrRegistration = { company_identifier, company_name };
    delete req.session.hrRegistration?.error;
    res.redirect("/auth");
  });

  // POST /auth/login – sign in by email+password or company_identifier+password
  router.post("/auth/login", async (req, res) => {
    const email = (req.body.email || "").trim().toLowerCase();
    const company_identifier =
      (req.body.company_identifier || "").trim() ||
      req.session.hrRegistration?.company_identifier ||
      "";
    const password = req.body.password;
    if (!password || password.length < 6) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "პაროლი მინიმუმ 6 სიმბოლო." };
      return res.redirect("/auth");
    }
    const byEmail = !!email;
    const account = byEmail
      ? await db("hr_accounts")
          .where({ email })
          .select("id", "email", "company_identifier", "company_name", "password_hash")
          .first()
      : await db("hr_accounts")
          .where({ company_identifier })
          .select("id", "email", "company_identifier", "company_name", "password_hash")
          .first();
    if (!byEmail && !company_identifier) {
      req.session.hrRegistration = { error: "კომპანიის საიდენტიფიკაციო აუცილებელია." };
      return res.redirect("/auth");
    }
    if (!account || !verifyPassword(password, account.password_hash)) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "არასწორი პაროლი." };
      return res.redirect("/auth");
    }
    req.session.hrUser = {
      id: account.id,
      email: account.email,
      company_identifier: account.company_identifier,
      company_name: account.company_name || account.company_identifier,
    };
    delete req.session.hrRegistration;
    return res.redirect("/dashboard");
  });

  // POST /auth/register – new company: email + password, save to hr_accounts (company_name + company_identifier), redirect to dashboard
  router.post("/auth/register", async (req, res) => {
    const company_identifier =
      (req.body.company_identifier || "").trim() ||
      req.session.hrRegistration?.company_identifier ||
      "";
    const company_name =
      (req.session.hrRegistration?.company_name || "").trim() || company_identifier;
    if (!company_identifier) {
      req.session.hrRegistration = { error: "პირველად შეიყვანეთ კომპანიის საიდენტიფიკაციო." };
      return res.redirect("/auth");
    }
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password;
    const repeat_password = req.body.repeat_password;

    if (!email) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "ელფოსტა აუცილებელია." };
      return res.redirect("/auth");
    }
    if (!password || password.length < 6) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "პაროლი მინიმუმ 6 სიმბოლო." };
      return res.redirect("/auth");
    }
    if (password !== repeat_password) {
      req.session.hrRegistration = { ...req.session.hrRegistration, error: "პაროლები არ ემთხვევა." };
      return res.redirect("/auth");
    }

    try {
      const row = await db.transaction(async (trx) => {
        const inserted = await trx("hr_accounts")
          .insert({
            company_identifier,
            company_name,
            email,
            password_hash: hashPassword(password),
          })
          .returning(["id", "email", "company_identifier", "company_name", "credits"]);
        const r = Array.isArray(inserted) ? inserted[0] : inserted;
        const credits = r && r.credits != null ? Number(r.credits) || 100 : 100;
        try {
          await trx("hr_credits_history").insert({
            hr_account_id: r.id,
            delta: 100,
            balance_after: credits,
            kind: "initial_grant",
          });
        } catch (e) {
          // If the table doesn't exist yet (older DB), ignore.
        }
        return r;
      });
      req.session.hrUser = {
        id: row?.id,
        email: row?.email ?? email,
        company_identifier: row?.company_identifier ?? company_identifier,
        company_name: row?.company_name ?? company_name,
      };
      delete req.session.hrRegistration;
      return res.redirect("/dashboard");
    } catch (err) {
      if (err.code === "23505") {
        req.session.hrRegistration = { ...req.session.hrRegistration, error: "ამ საიდენტიფიკაციო ნომრით უკვე დარეგისტრირებულია." };
      } else {
        console.error("hr/register error:", err);
        req.session.hrRegistration = { ...req.session.hrRegistration, error: "შეცდომა. სცადეთ თავიდან." };
      }
      return res.redirect("/auth");
    }
  });

  // Professions (categories) for HR search
  const PROFESSIONS = [
    { id: 1, name: "საოფისე" }, { id: 2, name: "მომხმარებელთან ურთიერთობები" }, { id: 3, name: "გაყიდვები" },
    { id: 4, name: "საბანკო-საფინანსო" }, { id: 5, name: "საწყობი და წარმოება" }, { id: 6, name: "საცალო ვაჭრობა" },
    { id: 7, name: "მზარეული" }, { id: 8, name: "აზარტული" }, { id: 9, name: "მენეჯმენტი" }, { id: 10, name: "ფარმაცია" },
    { id: 11, name: "მიმტანი" }, { id: 12, name: "ინჟინერია" }, { id: 13, name: "ლოჯისტიკა" }, { id: 14, name: "სამედიცინო" },
    { id: 15, name: "უსაფრთხოება" }, { id: 16, name: "დისტრიბუცია" }, { id: 17, name: "ინფორმაციული ტექნოლოგიები" },
    { id: 18, name: "დიასახლისი" }, { id: 19, name: "სხვა" }, { id: 20, name: "ბუღალტერია" },
    { id: 21, name: "მძღოლი" }, { id: 22, name: "Web/Digital/Design" }, { id: 23, name: "ექთანი" },
    { id: 24, name: "ექიმი" }, { id: 25, name: "ადმინისტრატორი" }, { id: 26, name: "HR" },
  ];
  const LOCATIONS = ["თბილისი", "ქუთაისი", "ბათუმი", "ზუგდიდი", "გორი", "რუსთავი", "მცხეთა", "თელავი", "მესტია", "ფოთი", "ჭიათურა", "ზესტაფონი", "მარნეული"];

  // GET /dashboard – actual dashboard (logged-in only; skip auth when HR_SKIP_AUTH=1 for dev)
  router.get("/dashboard", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) return res.redirect("/auth");
    const hrUser = req.session.hrUser || { company_name: "Dev (no auth)", company_identifier: "-" };
    let company_name = hrUser.company_name || hrUser.company_identifier;
    if (!SKIP_HR_AUTH) {
      const companyData = await getCompanyByTaxId(hrUser.company_identifier);
      if (Array.isArray(companyData) && companyData[0]) {
        company_name = companyData[0].FullName || companyData[0].RegisteredSubject || company_name;
      }
    }
    const hrAccountId = await resolveHrAccountId(req);
    let credits = null;
    let creditsRaw = null;
    if (hrAccountId) {
      try {
        const row = await db("hr_accounts").where({ id: hrAccountId }).select("credits", db.raw("credits::text as credits_text")).first();
        if (row) {
          creditsRaw = row.credits_text != null ? row.credits_text : row.credits;
          credits = row.credits != null ? Number(row.credits) : null;
        }
      } catch (e) {
        credits = null;
      }
    }

    const sidebarActive = req.query.view === "history" ? "history" : "search";
    return res.render("hr/dashboard", {
      seo: { title: "HR Dashboard - Samushao.ge", description: "HR dashboard" },
      hrUser: { ...hrUser, company_name, credits, creditsDisplay: formatCreditsForDisplay(creditsRaw != null ? creditsRaw : credits) },
      professions: PROFESSIONS,
      locations: LOCATIONS,
      sidebarActive,
    });
  });

  // POST /dashboard/job-title – Gemini: extract/guess job title from description
  router.post("/dashboard/job-title", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) {
      return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    }
    const jobDescription = (req.body.job_description || "").toString().trim();
    if (!jobDescription || jobDescription.length < 20) {
      return res.status(400).json({ ok: false, error: "ვაკანსიის აღწერა საჭიროა (მინიმუმ 20 სიმბოლო)" });
    }
    try {
      const { generateJobTitleFromDescription } = require("../services/geminiJobTitle");
      const title = await withTimeout(
        generateJobTitleFromDescription(jobDescription),
        12000,
        "generate job title"
      );
      return res.json({ ok: true, title: (title || "").trim() });
    } catch (err) {
      console.error("hr/dashboard/job-title error:", err);
      return res.status(500).json({ ok: false, error: err.message || "შეცდომა" });
    }
  });

  // POST /dashboard/search – run Pinecone + Gemini, store in session, return redirect
  const VECTOR_MIN_SCORE = 0.4;
  const FETCH_MULTIPLIER = 6;
  // Assess more candidates when user wants lower match levels so we get actual variety (not just top vector = strong)
  function getAssessLimitMultiplier(minMatchLevel) {
    if (minMatchLevel === "partial") return 8; // need to go deeper to get PARTIAL_MATCH
    if (minMatchLevel === "good") return 5;
    return 4; // strong: only STRONG_MATCH
  }
  router.post("/dashboard/search", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) {
      return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    }
    const jobDescription = (req.body.job_description || "").trim();
    const jobTitle = (req.body.job_title || req.body.jobName || "").toString().trim();
    const topK = Math.min(50, Math.max(5, parseInt(req.body.topK, 10) || 10));
    const rawLevel = (req.body.minMatchLevel || "").toString().trim().toLowerCase();
    const minMatchLevel = ["strong", "good", "partial"].includes(rawLevel) ? rawLevel : "strong";
    // Each option returns only that match type: strong → STRONG only, good → GOOD only, partial → PARTIAL only
    const allowedVerdicts = minMatchLevel === "strong"
      ? ["STRONG_MATCH"]
      : minMatchLevel === "good"
        ? ["GOOD_MATCH"]
        : ["PARTIAL_MATCH"];
    const assessLimitMultiplier = getAssessLimitMultiplier(minMatchLevel);
    if (!jobDescription || jobDescription.length < 20) {
      return res.status(400).json({ ok: false, error: "განცხადების აღწერა საჭიროა (მინიმუმ 20 სიმბოლო)" });
    }
    const jobName =
      (jobTitle ? jobTitle.slice(0, 120) : "") ||
      jobDescription.split(/\n/)[0].trim().slice(0, 120) ||
      jobDescription.slice(0, 120) ||
      "ვაკანსია";
    try {
      const { getTopCandidatesForJob } = require("../services/pineconeCandidates");
      const {
        assessCandidateAlignment,
        assessNoCvAlignment,
      } = require("../services/geminiCandidateAssessment");
      const { extractTextFromCv } = require("../services/cvTextExtractor");

      const job = { jobDescription, jobName: "", job_city: "", job_experience: "", job_type: "" };
      const fetchCount = Math.min(100, Math.max(topK * 2, topK * FETCH_MULTIPLIER));
      const matches = await getTopCandidatesForJob({ jobDescription, requireRoleMatch: false }, fetchCount);
      const qualified = matches
        .filter((m) => (m.score || 0) >= VECTOR_MIN_SCORE)
        .slice(0, Math.min(matches.length, topK * assessLimitMultiplier));

      const realUserIds = qualified
        .filter((m) => !String(m.id).startsWith("no_cv_"))
        .map((m) => m.id);
      const noCvIds = qualified
        .filter((m) => String(m.id).startsWith("no_cv_"))
        .map((m) => parseInt(String(m.id).replace("no_cv_", ""), 10))
        .filter((n) => !isNaN(n) && n > 0);

      const users = realUserIds.length > 0
        ? await db("users").whereIn("user_uid", realUserIds).select("user_uid", "user_name", "user_email")
        : [];
      const userMap = Object.fromEntries(users.map((u) => [u.user_uid, u]));

      const resumeRows = realUserIds.length > 0
        ? await db("resumes").whereIn("user_id", realUserIds).orderBy("updated_at", "desc").select("user_id", "file_url", "file_name")
        : [];
      const resumeMap = {};
      resumeRows.forEach((r) => { if (!resumeMap[r.user_id]) resumeMap[r.user_id] = r; });

      const noCvRows = noCvIds.length > 0 ? await db("user_without_cv").whereIn("id", noCvIds).select("*") : [];
      const noCvMap = Object.fromEntries(noCvRows.map((r) => [r.id, r]));

      const lastSeenByUser = {};
      if (realUserIds.length > 0) {
        const rows = await db("visitors")
          .whereIn("user_id", realUserIds)
          .whereNotNull("last_seen")
          .select("user_id", "last_seen");
        rows.forEach((r) => {
          const uid = r.user_id;
          const t = r.last_seen ? new Date(r.last_seen).getTime() : 0;
          if (!lastSeenByUser[uid] || new Date(lastSeenByUser[uid]).getTime() < t) {
            lastSeenByUser[uid] = r.last_seen;
          }
        });
      }

      function formatLastSeen(iso) {
        if (!iso) return "უცნობია";
        const d = new Date(iso);
        const now = new Date();
        const diffDays = Math.floor((now - d) / (24 * 60 * 60 * 1000));
        if (diffDays === 0) return "დღეს";
        if (diffDays === 1) return "1 დღის წინ";
        if (diffDays < 7) return diffDays + " დღის წინ";
        if (diffDays < 30) return Math.floor(diffDays / 7) + " კვირის წინ";
        if (diffDays < 365) return Math.floor(diffDays / 30) + " თვის წინ";
        return Math.floor(diffDays / 365) + " წლის წინ";
      }
      function firstName(full) {
        const s = (full || "").trim();
        return s ? s.split(/\s+/)[0] : "უცნობი";
      }

      const candidates = [];
      for (const m of qualified) {
        const isNoCv = String(m.id).startsWith("no_cv_");
        let fullName = "";
        let initials = "?";
        let aiSummary = "";
        let verdict = "PARTIAL_MATCH";
        let lastSeen = null;
        let cvUrl = null;
        let email = null;
        let phone = null;

        if (isNoCv) {
          const nid = parseInt(String(m.id).replace("no_cv_", ""), 10);
          const row = noCvMap[nid];
          if (!row) continue;
          fullName = (row.name || "").trim() || "უცნობი";
          initials = fullName ? fullName.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase() : "?";
          email = (row.email || "").trim() || null;
          phone = (row.phone || "").trim() || null;
          try {
            const result = await assessNoCvAlignment(job, row);
            aiSummary = result.summary || "";
            verdict = (result.verdict && ["STRONG_MATCH", "GOOD_MATCH", "PARTIAL_MATCH", "WEAK_MATCH"].includes(result.verdict))
              ? result.verdict
              : verdict;
          } catch (e) {
            aiSummary = "";
          }
        } else {
          const u = userMap[m.id];
          fullName = (u?.user_name || "").trim() || "უცნობი";
          initials = fullName ? fullName.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase() : "?";
          email = (u?.user_email || "").trim() || null;
          lastSeen = lastSeenByUser[m.id] || null;
          const res = resumeMap[m.id];
          cvUrl = res?.file_url || null;

          const cvText = m.metadata?.text || (res?.file_url
            ? await extractTextFromCv(res.file_url, res.file_name).catch(() => "")
            : "");
          if (cvText && cvText.length >= 30) {
            try {
              const result = await assessCandidateAlignment(job, cvText);
              aiSummary = result.summary || "";
              verdict = (result.verdict && ["STRONG_MATCH", "GOOD_MATCH", "PARTIAL_MATCH", "WEAK_MATCH"].includes(result.verdict))
                ? result.verdict
                : verdict;
            } catch (e) {
              aiSummary = "";
            }
          }
        }
        if (!allowedVerdicts.includes(verdict)) continue;
        candidates.push({
          id: m.id,
          fullName: fullName || firstName(fullName),
          firstName: firstName(fullName),
          initials,
          aiSummary,
          verdict,
          score: m.score ?? 0,
          lastSeenFormatted: formatLastSeen(lastSeen ? new Date(lastSeen).toISOString() : null),
          cvUrl,
          email,
          phone,
        });
      }
      // When user chose "partial", sort by vector score only so they see a mix (not always strongest first)
      if (minMatchLevel === "partial") {
        candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      } else {
        const verdictOrder = { STRONG_MATCH: 0, GOOD_MATCH: 1, PARTIAL_MATCH: 2 };
        candidates.sort((a, b) => {
          const va = verdictOrder[a.verdict] ?? 3;
          const vb = verdictOrder[b.verdict] ?? 3;
          if (va !== vb) return va - vb;
          return (b.score ?? 0) - (a.score ?? 0);
        });
      }
      const finalCandidates = candidates.slice(0, topK).map(({ score, ...c }) => c);
      return res.json({ ok: true, jobName, candidates: finalCandidates });
    } catch (err) {
      console.error("hr/dashboard/search error:", err);
      return res.status(500).json({ ok: false, error: err.message || "შეცდომა ძებნისას" });
    }
  });

  // In skip-auth mode, use a dev HR account so "მიიღე რეზიუმე" saves to DB and shows on candidates page.
  const HR_DEV_ACCOUNT_ID = process.env.HR_DEV_ACCOUNT_ID ? parseInt(process.env.HR_DEV_ACCOUNT_ID, 10) : null;

  async function resolveHrAccountId(req) {
    const id = req.session.hrUser?.id;
    if (id) return id;
    if (!SKIP_HR_AUTH) return null;
    if (HR_DEV_ACCOUNT_ID) return HR_DEV_ACCOUNT_ID;
    const row = await db("hr_accounts").orderBy("id").select("id").first();
    return row ? row.id : null;
  }

  // GET /dashboard/credits/history – credits spend/gain history list
  router.get("/dashboard/credits/history", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) {
      return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    }
    const hrAccountId = await resolveHrAccountId(req);
    if (!hrAccountId) return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    try {
      const rows = await withTimeout(
        db("hr_credits_history")
          .where("hr_account_id", hrAccountId)
          .orderBy("created_at", "desc")
          .limit(200)
          .select("id", "delta", "balance_after", "kind", "job_name", "match_verdict", "created_at"),
        2500,
        "load credits history"
      );
      // Coerce decimals to numbers (PostgreSQL returns decimal columns as strings)
      const history = (rows || []).map((r) => ({
        ...r,
        delta: r.delta != null ? Number(r.delta) : 0,
        balance_after: r.balance_after != null ? Number(r.balance_after) : 0,
      }));
      return res.json({ ok: true, history });
    } catch (err) {
      console.error("hr/dashboard/credits/history error:", err);
      return res.status(500).json({ ok: false, error: err.message || "შეცდომა" });
    }
  });

  function creditsCostForVerdict(verdict) {
    if (verdict === "STRONG_MATCH") return 2;
    if (verdict === "GOOD_MATCH") return 1;
    if (verdict === "PARTIAL_MATCH") return 0.5;
    return null;
  }

  function verdictDisplay(verdict) {
    if (verdict === "STRONG_MATCH") return { label: "სრული შესაბამისობა", class: "text-white bg-[#315EFF]" };
    if (verdict === "GOOD_MATCH") return { label: "კარგი შესაბამისობა", class: "text-white bg-[#16a34a]" };
    if (verdict === "PARTIAL_MATCH") return { label: "ნაწილობრივი შესაბამისობა", class: "text-[#0F172A] bg-slate-200" };
    return null;
  }

  // POST /dashboard/candidates/check – check if HR already has this candidate (no charge, no duplicate)
  router.post("/dashboard/candidates/check", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) {
      return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    }
    const hrAccountId = await resolveHrAccountId(req);
    if (!hrAccountId) return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    const jobName = (req.body.jobName || req.body.job_name || "").trim().slice(0, 255);
    const candidateId = String(req.body.candidateId || req.body.candidate_id || "").trim().slice(0, 64);
    if (!jobName || !candidateId) {
      return res.status(400).json({ ok: false, error: "jobName და candidateId აუცილებელია" });
    }
    try {
      const existing = await db("hr_requested_resumes")
        .where({ hr_account_id: hrAccountId, job_name: jobName, candidate_id: candidateId })
        .select("id")
        .first();
      return res.json({ ok: true, already: !!existing });
    } catch (err) {
      console.error("hr/dashboard/candidates/check error:", err);
      return res.status(500).json({ ok: false, error: err.message || "შეცდომა" });
    }
  });

  // POST /dashboard/candidates/request – save requested resume (when user clicks "მიიღე რეზიუმე")
  router.post("/dashboard/candidates/request", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) {
      return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    }
    const hrAccountId = await resolveHrAccountId(req);
    if (!hrAccountId) {
      return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    }
    const jobName = (req.body.jobName || req.body.job_name || "").trim().slice(0, 255);
    const c = req.body.candidate;
    if (!jobName || !c || typeof c !== "object") {
      return res.status(400).json({ ok: false, error: "jobName და candidate აუცილებელია" });
    }
    const candidateId = String(c.id || "").trim().slice(0, 64);
    const fullName = (c.fullName || c.full_name || "").trim().slice(0, 255) || "უცნობი";
    const email = (c.email || "").trim().slice(0, 255) || null;
    const cvUrl = (c.cvUrl || c.cv_url || "").trim() || null;
    const aiSummary = (c.aiSummary || c.ai_summary || "").trim() || null;
    const matchVerdict = String(c.verdict || c.match_verdict || "").trim().toUpperCase();
    const cost = creditsCostForVerdict(matchVerdict);
    if (!candidateId) {
      return res.status(400).json({ ok: false, error: "candidate.id აუცილებელია" });
    }
    if (cost === undefined || cost === null) {
      return res.status(400).json({ ok: false, error: "შესაბამისობის ტიპი არასწორია" });
    }
    let outcome = null;
    try {
      outcome = await withTimeout(
        db.transaction(async (trx) => {
          const existing = await trx("hr_requested_resumes")
            .where({ hr_account_id: hrAccountId, job_name: jobName, candidate_id: candidateId })
            .select("id")
            .first();
          if (existing) {
            const balRow = await trx("hr_accounts").where({ id: hrAccountId }).select("credits").first();
            const currentCredits = balRow && balRow.credits != null ? Number(balRow.credits) : null;
            return { already: true, credits: currentCredits };
          }

          let newBalance = null;
          if (cost > 0) {
            const balLocked = await trx("hr_accounts").where({ id: hrAccountId }).forUpdate().select("credits").first();
            const current = balLocked && balLocked.credits != null ? Number(balLocked.credits) || 0 : 0;

            const existingAfterLock = await trx("hr_requested_resumes")
              .where({ hr_account_id: hrAccountId, job_name: jobName, candidate_id: candidateId })
              .select("id")
              .first();
            if (existingAfterLock) {
              return { already: true, credits: current };
            }

            if (current < cost) {
              return { insufficient: true, credits: current };
            }
            newBalance = current - cost;
            await trx("hr_accounts").where({ id: hrAccountId }).update({ credits: newBalance });
            await trx("hr_credits_history").insert({
              hr_account_id: hrAccountId,
              delta: -cost,
              balance_after: newBalance,
              kind: "unlock_candidate",
              job_name: jobName,
              candidate_id: candidateId,
              match_verdict: matchVerdict,
            });
          } else {
            const balRow = await trx("hr_accounts").where({ id: hrAccountId }).select("credits").first();
            newBalance = balRow && balRow.credits != null ? Number(balRow.credits) || 0 : 0;
          }

          await trx("hr_requested_resumes").insert({
            hr_account_id: hrAccountId,
            job_name: jobName,
            candidate_id: candidateId,
            full_name: fullName,
            email,
            cv_url: cvUrl,
            ai_summary: aiSummary,
            match_verdict: ["STRONG_MATCH", "GOOD_MATCH", "PARTIAL_MATCH"].includes(matchVerdict) ? matchVerdict : null,
          });

          return { ok: true, credits: newBalance };
        }),
        6000,
        "charge credits + save requested resume"
      );

      if (outcome?.insufficient) {
        return res.status(402).json({ ok: false, error: "საკმარისი კრედიტები არ გაქვთ", credits: outcome.credits });
      }
      if (outcome?.already) {
        return res.json({ ok: true, credits: outcome.credits, already: true });
      }
    } catch (err) {
      console.error("hr/dashboard/candidates/request error:", err);
      return res.status(500).json({ ok: false, error: err.message || "შეცდომა" });
    }
    return res.json({ ok: true, credits: outcome?.credits });
  });

  // GET /dashboard/candidates/cv-preview – proxy CV for inline display (iframe; Cloudinary attachment URLs force download)
  router.get("/dashboard/candidates/cv-preview", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) return res.status(401).send("Unauthorized");
    const hrAccountId = await resolveHrAccountId(req);
    if (!hrAccountId) return res.status(401).send("Unauthorized");
    const jobName = (req.query.jobName || req.query.job_name || "").trim().slice(0, 255);
    const candidateId = String(req.query.candidateId || req.query.candidate_id || "").trim().slice(0, 64);
    if (!jobName || !candidateId) return res.status(400).send("Missing jobName or candidateId");
    try {
      const row = await db("hr_requested_resumes")
        .where({ hr_account_id: hrAccountId, job_name: jobName, candidate_id: candidateId })
        .select("cv_url")
        .first();
      if (!row?.cv_url) return res.status(404).send("CV not found");
      const url = String(row.cv_url).trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) return res.status(400).send("Invalid URL");
      const ext = (url.split("?")[0] || "").toLowerCase().match(/\.(pdf|doc|docx|jpg|jpeg|png|gif|webp)(\?|$)/)?.[1] || "pdf";
      const mime = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || "application/octet-stream";
      const fetchRes = await fetch(url);
      if (!fetchRes.ok) return res.status(502).send("Failed to fetch CV");
      const buf = Buffer.from(await fetchRes.arrayBuffer());
      if (ext === "pdf" && buf.length >= 5 && buf.subarray(0, 5).toString() !== "%PDF-") {
        return res.status(502).send("Invalid CV file");
      }
      res.set("Content-Type", mime);
      res.set("Content-Disposition", "inline");
      res.send(buf);
    } catch (err) {
      console.error("hr/dashboard/candidates/cv-preview error:", err);
      res.status(500).send("Error loading CV");
    }
  });

  // POST /dashboard/candidates/remove – remove a candidate from the list (confirm on frontend)
  router.post("/dashboard/candidates/remove", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) {
      return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    }
    const hrAccountId = await resolveHrAccountId(req);
    if (!hrAccountId) return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    const jobName = (req.body.jobName || req.body.job_name || "").trim().slice(0, 255);
    const candidateId = String(req.body.candidateId || req.body.candidate_id || "").trim().slice(0, 64);
    if (!jobName || !candidateId) {
      return res.status(400).json({ ok: false, error: "jobName და candidateId აუცილებელია" });
    }
    try {
      const deleted = await db("hr_requested_resumes")
        .where({ hr_account_id: hrAccountId, job_name: jobName, candidate_id: candidateId })
        .delete();
      return res.json({ ok: true, deleted: deleted > 0 });
    } catch (err) {
      console.error("hr/dashboard/candidates/remove error:", err);
      return res.status(500).json({ ok: false, error: err.message || "შეცდომა" });
    }
  });

  // GET /dashboard/candidates – show resumes requested via "მიიღე რეზიუმე", grouped by job name
  router.get("/dashboard/candidates", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) return res.redirect("/auth");
    let jobsWithResumes = [];
    const hrUser = req.session.hrUser || { company_name: "Dev (no auth)", company_identifier: "-" };
    const hrAccountId = await resolveHrAccountId(req);
    let credits = null;
    let creditsRaw = null;
    if (hrAccountId) {
      try {
        const row = await db("hr_accounts").where({ id: hrAccountId }).select("credits", db.raw("credits::text as credits_text")).first();
        if (row) {
          creditsRaw = row.credits_text != null ? row.credits_text : row.credits;
          credits = row.credits != null ? Number(row.credits) : null;
        }
      } catch (e) {
        credits = null;
      }
    }
    const hrUserWithCredits = { ...hrUser, company_name: hrUser.company_name || hrUser.company_identifier, credits, creditsDisplay: formatCreditsForDisplay(creditsRaw != null ? creditsRaw : credits) };
    if (!hrAccountId) {
      return res.render("hr/candidates", {
        seo: { title: "კანდიდატები - Samushao.ge", description: "HR კანდიდატების შედეგები" },
        hrUser: hrUserWithCredits,
        jobsWithResumes,
      });
    }
    try {
      const rows = await withTimeout(
        db("hr_requested_resumes")
          .where("hr_account_id", hrAccountId)
          .orderBy("job_name")
          .orderBy("created_at", "desc")
          .select("job_name", "candidate_id", "full_name", "email", "cv_url", "ai_summary", "match_verdict"),
        2500,
        "load requested resumes"
      );
      const realUserIds = [...new Set((rows || []).map((r) => r.candidate_id).filter((id) => id && !String(id).startsWith("no_cv_")))];
      const lastSeenByCandidate = {};
      if (realUserIds.length > 0) {
        const lastSeenRows = await db("visitors")
          .whereIn("user_id", realUserIds)
          .whereNotNull("last_seen")
          .select("user_id", "last_seen");
        lastSeenRows.forEach((row) => {
          const uid = row.user_id;
          const t = row.last_seen ? new Date(row.last_seen).getTime() : 0;
          if (!lastSeenByCandidate[uid] || new Date(lastSeenByCandidate[uid]).getTime() < t) {
            lastSeenByCandidate[uid] = row.last_seen;
          }
        });
      }
      function formatLastSeen(iso) {
        if (!iso) return null;
        const d = new Date(iso);
        const now = new Date();
        const diffDays = Math.floor((now - d) / (24 * 60 * 60 * 1000));
        if (diffDays === 0) return "დღეს";
        if (diffDays === 1) return "1 დღის წინ";
        if (diffDays < 7) return diffDays + " დღის წინ";
        if (diffDays < 30) return Math.floor(diffDays / 7) + " კვირის წინ";
        if (diffDays < 365) return Math.floor(diffDays / 30) + " თვის წინ";
        return Math.floor(diffDays / 365) + " წლის წინ";
      }
      const byJob = {};
      for (const r of rows) {
        if (!byJob[r.job_name]) byJob[r.job_name] = [];
        const lastSeen = lastSeenByCandidate[r.candidate_id] || null;
        const vd = verdictDisplay(r.match_verdict);
        byJob[r.job_name].push({
          candidate_id: r.candidate_id,
          full_name: r.full_name,
          email: r.email,
          cv_url: r.cv_url,
          ai_summary: r.ai_summary,
          last_visit: lastSeen ? formatLastSeen(lastSeen) : null,
          match_verdict: r.match_verdict || null,
          match_verdict_label: vd ? vd.label : null,
          match_verdict_class: vd ? vd.class : null,
        });
      }
      jobsWithResumes = Object.entries(byJob).map(([jobName, resumes]) => ({ jobName, resumes }));
    } catch (e) {
      console.error("hr/dashboard/candidates load error:", e);
    }
    return res.render("hr/candidates", {
      seo: { title: "კანდიდატები - Samushao.ge", description: "HR კანდიდატების შედეგები" },
      hrUser: { ...hrUserWithCredits, creditsDisplay: formatCreditsForDisplay(creditsRaw != null ? creditsRaw : credits) },
      jobsWithResumes,
    });
  });

  // Email transporter for HR credits purchase notifications (uses PROPOSITIONAL_MAIL_* as sender, to giorgi@samushao.ge)
  const PROPOSITIONAL_MAIL_USER = (process.env.PROPOSITIONAL_MAIL_USER || "").trim();
  const PROPOSITIONAL_MAIL_PASS = (process.env.PROPOSITIONAL_MAIL_PASS || "").trim();
  const hrCreditsTransporter =
    PROPOSITIONAL_MAIL_USER && PROPOSITIONAL_MAIL_PASS
      ? nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 587,
          secure: false,
          auth: { user: PROPOSITIONAL_MAIL_USER, pass: PROPOSITIONAL_MAIL_PASS },
        })
      : null;

  // POST /dashboard/credits/request – submit credits purchase request, send email to giorgi@samushao.ge
  router.post("/dashboard/credits/request", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) {
      return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    }
    const hrAccountId = await resolveHrAccountId(req);
    if (!hrAccountId) return res.status(401).json({ ok: false, error: "ავტორიზაცია საჭიროა" });
    const credits = parseInt(req.body.credits, 10);
    if (!credits || credits < 1 || credits > 999) {
      return res.status(400).json({ ok: false, error: "კრედიტების რაოდენობა უნდა იყოს 1–999" });
    }
    let companyIdentifier = "";
    let userEmail = "";
    try {
      const row = await db("hr_accounts").where({ id: hrAccountId }).select("company_identifier", "email").first();
      if (row) {
        companyIdentifier = row.company_identifier || "";
        userEmail = row.email || "";
      }
    } catch (e) {
      console.error("hr/dashboard/credits/request load account error:", e);
      return res.status(500).json({ ok: false, error: "შეცდომა" });
    }
    if (hrCreditsTransporter) {
      try {
        await hrCreditsTransporter.sendMail({
          from: PROPOSITIONAL_MAIL_USER,
          to: "giorgi@samushao.ge",
          subject: "HR კრედიტების ყიდვის მოთხოვნა – Samushao.ge",
          text: [
            "კომპანიის საიდენტიფიკაციო ნომერი: " + companyIdentifier,
            "მომხმარებლის ელფოსტა: " + userEmail,
            "საყიდელი კრედიტების რაოდენობა: " + credits,
          ].join("\n"),
          html:
            "<p><strong>კომპანიის საიდენტიფიკაციო ნომერი:</strong> " +
            (companyIdentifier || "—") +
            "</p>" +
            "<p><strong>მომხმარებლის ელფოსტა:</strong> " +
            (userEmail || "—") +
            "</p>" +
            "<p><strong>საყიდელი კრედიტების რაოდენობა:</strong> " +
            credits +
            "</p>",
        });
      } catch (err) {
        console.error("hr/dashboard/credits/request send mail error:", err);
        return res.status(500).json({ ok: false, error: "ელფოსტის გაგზავნა ვერ მოხერხდა" });
      }
    }
    return res.json({ ok: true });
  });

  // GET /dashboard/credits – buy credits page
  router.get("/dashboard/credits", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) return res.redirect("/auth");
    const hrUser = req.session.hrUser || { company_name: "Dev (no auth)", company_identifier: "-" };
    const hrAccountId = await resolveHrAccountId(req);
    let credits = null;
    let creditsRaw = null;
    let accountEmail = hrUser.email || "";
    if (hrAccountId) {
      try {
        const row = await db("hr_accounts").where({ id: hrAccountId }).select("credits", "email", db.raw("credits::text as credits_text")).first();
        if (row) {
          creditsRaw = row.credits_text != null ? row.credits_text : row.credits;
          credits = row.credits != null ? Number(row.credits) : null;
          if (row.email) accountEmail = row.email;
        }
      } catch (e) {
        credits = null;
      }
    }
    return res.render("hr/credits", {
      seo: { title: "კრედიტების ყიდვა - Samushao.ge", description: "კრედიტების შეძენა" },
      hrUser: { ...hrUser, company_name: hrUser.company_name || hrUser.company_identifier, credits, creditsDisplay: formatCreditsForDisplay(creditsRaw != null ? creditsRaw : credits), email: accountEmail },
    });
  });

  // GET /dashboard/credits-return – information about when we refund credits
  router.get("/dashboard/credits-return", async (req, res) => {
    if (!SKIP_HR_AUTH && !req.session.hrUser) return res.redirect("/auth");
    const hrUser = req.session.hrUser || { company_name: "Dev (no auth)", company_identifier: "-" };
    const hrAccountId = await resolveHrAccountId(req);
    let credits = null;
    let creditsRaw = null;
    if (hrAccountId) {
      try {
        const row = await db("hr_accounts")
          .where({ id: hrAccountId })
          .select("credits", db.raw("credits::text as credits_text"))
          .first();
        if (row) {
          creditsRaw = row.credits_text != null ? row.credits_text : row.credits;
          credits = row.credits != null ? Number(row.credits) : null;
        }
      } catch (e) {
        credits = null;
      }
    }
    return res.render("hr/credits-return", {
      seo: {
        title: "რა შემთხვევაში ვაბრუნებთ კრედიტებს - Samushao.ge",
        description: "ინფორმაცია HR კრედიტების დაბრუნების წესებზე",
      },
      hrUser: {
        ...hrUser,
        company_name: hrUser.company_name || hrUser.company_identifier,
        credits,
        creditsDisplay: formatCreditsForDisplay(creditsRaw != null ? creditsRaw : credits),
      },
    });
  });

  // POST /dashboard/logout
  router.post("/dashboard/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("hr logout session.destroy error:", err);
      }
      res.redirect("/auth");
    });
  });

  return router;
};
