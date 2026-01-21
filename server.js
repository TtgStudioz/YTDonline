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
  if (!process.env.COOKIES_URL) throw new Error("COOKIES_URL not set");
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set");

  try {
    const res = await fetch(process.env.COOKIES_URL, {
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  // yt-dlp
  if (!fs.existsSync(ytDlpPath)) {
    console.log("Downloading yt-dlp...");
    const res = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp");
    const buffer = await res.buffer();
    fs.writeFileSync(ytDlpPath, buffer);
    fs.chmodSync(ytDlpPath, 0o755);
  }

  // FFmpeg static Linux
  if (!fs.existsSync(ffmpegPath)) {
    console.log("Downloading FFmpeg...");
    const ffmpegTar = path.join(tmpDir, "ffmpeg.tar.xz");
    const res = await fetch("https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz");
    const buffer = await res.buffer();
    fs.writeFileSync(ffmpegTar, buffer);

    execSync(`tar -xJf ${ffmpegTar} -C ${tmpDir}`);
    const folders = fs.readdirSync(tmpDir).filter(f => f.startsWith("ffmpeg-") && f.endsWith("-static"));
    if (folders.length === 0) throw new Error("FFmpeg folder not found after extraction");
    const ffmpegFolder = path.join(tmpDir, folders[0]);

    fs.renameSync(path.join(ffmpegFolder, "ffmpeg"), ffmpegPath);
    fs.chmodSync(ffmpegPath, 0o755);

    fs.rmSync(ffmpegFolder, { recursive: true, force: true });
    fs.unlinkSync(ffmpegTar);
  }
}

setupBinaries().then(() => console.log("Binaries ready"));

// ---------------- FETCH YOUTUBE METADATA ----------------
async function fetchYoutubeMetadata(youtubeUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-warnings",
      "--no-playlist",
      "--dump-json",
      youtubeUrl
    ];

    if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);

    execFile(ytDlpPath, args, (err, stdout, stderr) => {
      if (err) return reject(stderr || err);
      try {
        const info = JSON.parse(stdout);
        // title + channel name
        const query = `${info.title} ${info.uploader}`;
        resolve(query);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------------- DOWNLOAD ROUTE ----------------
app.post("/download", async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "Missing YouTube URL" });

  try {
    await getSpotifyToken();

    // 1️⃣ Fetch YouTube metadata
    const searchQuery = await fetchYoutubeMetadata(youtubeUrl);

    // 2️⃣ Search Spotify using title + uploader
    const search = await spotify.searchTracks(searchQuery, { limit: 1 });
    const track = search.body.tracks.items[0];
    if (!track) throw new Error("Track not found on Spotify");

    const title = track.name;
    const artist = track.artists.map(a => a.name).join(", ");
    const album = track.album.name;
    const coverUrl = track.album.images[0].url;

    const safeTitle = title.replace(/[^a-zA-Z0-9 ]/g, "");
    const downloadsDir = path.join(tmpDir, "downloads");
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

    const tempAudio = path.join(downloadsDir, "temp.mp3");
    const coverPath = path.join(downloadsDir, "cover.jpg");
    const finalOutput = path.join(downloadsDir, `${safeTitle}.mp3`);

    // 3️⃣ Download cover
    console.log("Downloading cover image...");
    const response = await fetch(coverUrl);
    const buffer = await response.buffer();
    fs.writeFileSync(coverPath, buffer);

    // 4️⃣ Download YouTube audio
    console.log("Downloading YouTube audio...");
    await new Promise((resolve, reject) => {
      const args = [
        "-x", "--audio-format", "mp3",
        "--ffmpeg-location", ffmpegPath,
        "--js-runtime", "node",
        "-o", tempAudio,
        youtubeUrl
      ];

      if (fs.existsSync(cookiesPath)) args.push("--cookies", cookiesPath);

      execFile(ytDlpPath, args, (err, stdout, stderr) => {
        if (err) return reject(stderr || err);
        resolve();
      });
    });

    // 5️⃣ Embed metadata
    console.log("Embedding metadata...");
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
        finalOutput
      ], (err, stdout, stderr) => {
        if (err) return reject(stderr || err);
        resolve();
      });
    });

    // Cleanup
    fs.unlinkSync(tempAudio);
    fs.unlinkSync(coverPath);

    console.log("Sending file to browser...");
    res.download(finalOutput);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------- START SERVER ----------------
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running...");
});