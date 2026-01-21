require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile, execSync } = require("child_process");
const SpotifyWebApi = require("spotify-web-api-node");
const fetch = require("node-fetch"); // npm install node-fetch@2

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ---------------- SPOTIFY ----------------
const spotify = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

async function getSpotifyToken() {
  const data = await spotify.clientCredentialsGrant();
  spotify.setAccessToken(data.body.access_token);
}

// ---------------- TEMP DIR ----------------
const tmpDir = os.tmpdir();
const ytDlpPath = path.join(tmpDir, "yt-dlp");
const ffmpegPath = path.join(tmpDir, "ffmpeg");

// ---------------- COOKIES ----------------
const cookiesPath = path.join(tmpDir, "cookies.txt");

async function fetchCookies() {
  if (!process.env.COOKIES_URL) return;
  if (!process.env.GITHUB_TOKEN) return;

  try {
    const res = await fetch(process.env.COOKIES_URL, {
      headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
    });
    const txt = await res.text();
    fs.writeFileSync(cookiesPath, txt);
    console.log("Cookies updated");
  } catch (e) {
    console.error("Failed to fetch cookies:", e);
  }
}

fetchCookies();
setInterval(fetchCookies, 12 * 60 * 60 * 1000);

// ---------------- SETUP BINARIES ----------------
async function setupBinaries() {
  if (!fs.existsSync(ytDlpPath)) {
    console.log("Downloading yt-dlp...");
    const res = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp");
    fs.writeFileSync(ytDlpPath, await res.buffer());
    fs.chmodSync(ytDlpPath, 0o755);
  }

  if (!fs.existsSync(ffmpegPath)) {
    console.log("Downloading FFmpeg...");
    const tarPath = path.join(tmpDir, "ffmpeg.tar.xz");
    const res = await fetch("https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz");
    fs.writeFileSync(tarPath, await res.buffer());

    execSync(`tar -xJf ${tarPath} -C ${tmpDir}`);
    const folder = fs.readdirSync(tmpDir).find(f => f.startsWith("ffmpeg-") && f.endsWith("-static"));
    fs.renameSync(path.join(tmpDir, folder, "ffmpeg"), ffmpegPath);
    fs.chmodSync(ffmpegPath, 0o755);

    fs.rmSync(path.join(tmpDir, folder), { recursive: true, force: true });
    fs.unlinkSync(tarPath);
  }
}

setupBinaries();

// ---------------- YOUTUBE METADATA ----------------
async function fetchYoutubeMetadata(url) {
  return new Promise((resolve, reject) => {
    const args = ["--dump-json", "--no-playlist", url];
    if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);

    execFile(ytDlpPath, args, (err, stdout) => {
      if (err) return reject(err);
      const info = JSON.parse(stdout);
      resolve(`${info.title} ${info.uploader}`);
    });
  });
}

// ---------------- PROGRESS STREAM ----------------
app.get("/download-progress", async (req, res) => {
  const youtubeUrl = req.query.url;
  if (!youtubeUrl) return res.end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await getSpotifyToken();
    send({ status: "Fetching metadata..." });

    const searchQuery = await fetchYoutubeMetadata(youtubeUrl);
    send({ status: "Searching Spotify..." });

    const search = await spotify.searchTracks(searchQuery, { limit: 1 });
    const track = search.body.tracks.items[0];
    if (!track) throw new Error("Track not found");

    const title = track.name;
    const artist = track.artists.map(a => a.name).join(", ");
    const album = track.album.name;
    const coverUrl = track.album.images[0].url;

    const safeTitle = title.replace(/[^a-zA-Z0-9 ]/g, "");
    const downloadsDir = path.join(tmpDir, "downloads");
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

    const tempAudio = path.join(downloadsDir, "temp.mp3");
    const coverPath = path.join(downloadsDir, "cover.jpg");
    const finalFile = `${safeTitle}.mp3`;
    const finalPath = path.join(downloadsDir, finalFile);

    send({ status: "Downloading cover..." });
    const coverRes = await fetch(coverUrl);
    fs.writeFileSync(coverPath, await coverRes.buffer());

    send({ status: "Downloading audio...", progress: "0%" });

    const args = [
      "-x",
      "--audio-format", "mp3",
      "--newline",
      "--progress-template", "%(progress._percent_str)s",
      "--ffmpeg-location", ffmpegPath,
      "-o", tempAudio,
      youtubeUrl
    ];

    if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);

    const yt = execFile(ytDlpPath, args);

    yt.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text.includes("%")) {
        send({ progress: text });
      }
    });

    yt.on("close", async () => {
      send({ status: "Embedding metadata..." });

      await new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
          "-y",
          "-i", tempAudio,
          "-i", coverPath,
          "-map", "0:0",
          "-map", "1:0",
          "-c", "copy",
          "-id3v2_version", "3",
          "-metadata", `title=${title}`,
          "-metadata", `artist=${artist}`,
          "-metadata", `album=${album}`,
          finalPath
        ], err => err ? reject(err) : resolve());
      });

      fs.unlinkSync(tempAudio);
      fs.unlinkSync(coverPath);

      send({ done: true, filename: finalFile });
      res.end();
    });

  } catch (e) {
    send({ error: e.message });
    res.end();
  }
});

// ---------------- FILE DOWNLOAD ----------------
app.get("/download-file", (req, res) => {
  const filePath = path.join(os.tmpdir(), "downloads", req.query.file);
  res.download(filePath);
});

// ---------------- START SERVER ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port 3000");
});
