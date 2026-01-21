require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile, execSync } = require("child_process");
const SpotifyWebApi = require("spotify-web-api-node");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

/* ================= SPOTIFY ================= */
const spotify = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

async function getSpotifyToken() {
  const data = await spotify.clientCredentialsGrant();
  spotify.setAccessToken(data.body.access_token);
}

/* ================= PATHS ================= */
const tmpDir = os.tmpdir();
const ytDlpPath = path.join(tmpDir, "yt-dlp");
const ffmpegPath = path.join(tmpDir, "ffmpeg");
const cookiesPath = path.join(tmpDir, "cookies.txt");

/* ================= PROGRESS (SSE) ================= */
let clients = [];

app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  clients.push(res);

  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

function sendProgress(percent, message) {
  clients.forEach(res =>
    res.write(`data: ${JSON.stringify({ percent, message })}\n\n`)
  );
}

/* ================= COOKIES ================= */
async function fetchCookies() {
  if (!process.env.COOKIES_URL || !process.env.GITHUB_TOKEN) return;

  const res = await fetch(process.env.COOKIES_URL, {
    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
  });

  const txt = await res.text();
  fs.writeFileSync(cookiesPath, txt);
  console.log("Cookies updated");
}

fetchCookies();
setInterval(fetchCookies, 12 * 60 * 60 * 1000);

/* ================= BINARIES ================= */
async function setupBinaries() {
  if (!fs.existsSync(ytDlpPath)) {
    const r = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp");
    fs.writeFileSync(ytDlpPath, await r.buffer());
    fs.chmodSync(ytDlpPath, 0o755);
  }

  if (!fs.existsSync(ffmpegPath)) {
    const tar = path.join(tmpDir, "ffmpeg.tar.xz");
    const r = await fetch("https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz");
    fs.writeFileSync(tar, await r.buffer());
    execSync(`tar -xJf ${tar} -C ${tmpDir}`);
    const dir = fs.readdirSync(tmpDir).find(d => d.startsWith("ffmpeg-"));
    fs.renameSync(path.join(tmpDir, dir, "ffmpeg"), ffmpegPath);
    fs.chmodSync(ffmpegPath, 0o755);
  }
}

setupBinaries().then(() => console.log("Binaries ready"));

/* ================= YOUTUBE META ================= */
function getYoutubeQuery(url) {
  return new Promise((resolve, reject) => {
    const args = ["--dump-json", "--no-playlist", url];
    if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);

    execFile(ytDlpPath, args, (err, out) => {
      if (err) return reject(err);
      const info = JSON.parse(out);
      resolve(`${info.title} ${info.uploader}`);
    });
  });
}

/* ================= PREVIEW ================= */
app.post("/preview", async (req, res) => {
  try {
    await getSpotifyToken();
    const query = await getYoutubeQuery(req.body.youtubeUrl);
    const s = await spotify.searchTracks(query, { limit: 1 });
    const t = s.body.tracks.items[0];

    res.json({
      title: t.name,
      artist: t.artists.map(a => a.name).join(", "),
      album: t.album.name,
      cover: t.album.images[0].url
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= DOWNLOAD ================= */
app.post("/download", async (req, res) => {
  try {
    await getSpotifyToken();
    const query = await getYoutubeQuery(req.body.youtubeUrl);
    const s = await spotify.searchTracks(query, { limit: 1 });
    const t = s.body.tracks.items[0];

    const dir = path.join(tmpDir, "dl");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    const temp = path.join(dir, "temp.mp3");
    const cover = path.join(dir, "cover.jpg");
    const out = path.join(dir, `${t.name.replace(/[^a-z0-9 ]/gi, "")}.mp3`);

    const img = await fetch(t.album.images[0].url);
    fs.writeFileSync(cover, await img.buffer());

    await new Promise((resolve, reject) => {
      const args = [
        "-x", "--audio-format", "mp3",
        "--newline",
        "--ffmpeg-location", ffmpegPath,
        "-o", temp,
        req.body.youtubeUrl
      ];
      if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);

      const p = execFile(ytDlpPath, args);
      p.stdout.on("data", d => {
        const m = d.toString().match(/(\d+\.\d+)%/);
        if (m) sendProgress(parseFloat(m[1]), "Downloading");
      });
      p.on("close", c => c === 0 ? resolve() : reject());
    });

    execSync(
      `${ffmpegPath} -y -i "${temp}" -i "${cover}" -map 0 -map 1 -c copy ` +
      `-metadata title="${t.name}" -metadata artist="${t.artists[0].name}" ` +
      `-metadata album="${t.album.name}" "${out}"`
    );

    sendProgress(100, "Finished");
    res.download(out);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
