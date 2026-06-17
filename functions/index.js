const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const https = require("https");

admin.initializeApp();
const db = admin.firestore();

const GITHUB_TOKEN = defineSecret("GITHUB_TOKEN");
const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

const GITHUB_USER = "hrkim91";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

const cache = {};

// --------------------------------------------------
// GitHub API 프록시 (Rate Limit 방지, 5분 캐싱)
// --------------------------------------------------
exports.githubReleases = onRequest(
  { secrets: [GITHUB_TOKEN], cors: true },
  async (req, res) => {
    const repo = req.query.repo;
    if (!repo || !/^[\w.-]+$/.test(repo)) {
      return res.status(400).json({ error: "invalid repo" });
    }

    const cached = cache[repo];
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    try {
      const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/releases`;
      const data = await fetchJson(url, GITHUB_TOKEN.value());
      cache[repo] = { ts: Date.now(), data };
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// --------------------------------------------------
// GitHub Webhook 수신 → 이메일 알림 발송
// --------------------------------------------------
exports.sendReleaseNotification = onRequest(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] },
  async (req, res) => {
    // GitHub Webhook 이벤트 확인
    const event = req.headers["x-github-event"];
    if (event !== "release" || req.body.action !== "published") {
      return res.status(200).send("ignored");
    }

    const release = req.body.release;
    const repoName = req.body.repository.name;

    // Firestore에서 수신 이메일 목록 조회
    const doc = await db.collection("notificationSettings").doc("general").get();
    if (!doc.exists) {
      return res.status(200).send("no recipients");
    }
    const emails = doc.data().emails || [];
    if (emails.length === 0) {
      return res.status(200).send("no recipients");
    }

    // Gmail SMTP로 발송
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: GMAIL_USER.value(),
        pass: GMAIL_APP_PASSWORD.value(),
      },
    });

    const releaseUrl = release.html_url;
    const version = release.tag_name;
    const body = (release.body || "").replace(/^date:.*\n?/m, "").trim();

    await transporter.sendMail({
      from: `"GDSK New Firmware" <${GMAIL_USER.value()}>`,
      to: emails.join(", "),
      subject: `[펌웨어 업데이트] ${repoName} ${version}`,
      text: [
        `새 펌웨어가 게시되었습니다.`,
        ``,
        `제품: ${repoName}`,
        `버전: ${version}`,
        ``,
        body || "릴리즈 노트 없음",
        ``,
        `다운로드: ${releaseUrl}`,
      ].join("\n"),
    });

    res.status(200).send("sent");
  }
);

// --------------------------------------------------
// 내부 유틸
// --------------------------------------------------
function fetchJson(url, token) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "firmware-downloads-proxy",
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
      },
    };
    https.get(url, options, (r) => {
      let body = "";
      r.on("data", (chunk) => (body += chunk));
      r.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error("JSON parse error"));
        }
      });
    }).on("error", reject);
  });
}
