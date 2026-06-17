const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const https = require("https");

const GITHUB_TOKEN = defineSecret("GITHUB_TOKEN");
const GITHUB_USER = "hrkim91";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

const cache = {};

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
