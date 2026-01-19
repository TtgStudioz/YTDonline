require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile, execSync } = require("child_process");
const SpotifyWebApi = require("spotify-web-api-node");
const fetch = require("node-fetch"); // npm install node-fetch@2
const os = require("os");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const spotify = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

async function getSpotifyToken() {
  const data = await spotify.clientCredentialsGrant();
  spotify.setAccessToken(data.body.access_token);
}

// Render/Linux-friendly temp folder
const tmpDir = os.tmpdir();
const ytDlpPath = path.join(tmpDir, "yt-dlp");
const ffmpegPath = path.join(tmpDir, "ffmpeg");

// Download binaries if not present
async function setupBinaries() {
  // yt-dlp
  if (!fs.existsSync(ytDlpPath)) {
    console.log("Downloading yt-dlp...");
    const res = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp");
    const buffer = await res.buffer();
    fs.writeFileSync(ytDlpPath, buffer);
    fs.chmodSync(ytDlpPath, 0o755);
  }

  // FFmpeg static build (Linux)
    if (!fs.existsSync(ffmpegPath)) {
        console.log("Downloading FFmpeg...");
        const ffmpegTar = path.join(tmpDir, "ffmpeg.tar.xz");
        const res = await fetch("https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz");
        const buffer = await res.buffer();
        fs.writeFileSync(ffmpegTar, buffer);

        // Extract the ffmpeg binary
        execSync(`tar -xJf ${ffmpegTar} -C ${tmpDir}`);
        
        // The binary is inside a folder named like ffmpeg-*-amd64-static
        const files = fs.readdirSync(tmpDir).filter(f => f.startsWith("ffmpeg-") && f.endsWith("-static"));
        if (files.length === 0) throw new Error("FFmpeg folder not found after extraction");
        const ffmpegFolder = path.join(tmpDir, files[0]);
        fs.renameSync(path.join(ffmpegFolder, "ffmpeg"), ffmpegPath); // move ffmpeg binary to tmp
        fs.chmodSync(ffmpegPath, 0o755);

        // Clean up
        fs.rmSync(ffmpegFolder, { recursive: true, force: true });
        fs.unlinkSync(ffmpegTar);
    }

}

// Ensure binaries exist before handling requests
setupBinaries().then(() => console.log("Binaries ready"));

app.post("/download", async (req, res) => {
  const { youtubeUrl, searchQuery } = req.body;
  if (!youtubeUrl || !searchQuery) return res.status(400).json({ error: "Missing data" });

  try {
    await getSpotifyToken();
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

    console.log("Downloading cover image...");
    const response = await fetch(coverUrl);
    const buffer = await response.buffer();
    fs.writeFileSync(coverPath, buffer);

    console.log("Downloading YouTube audio...");
    await new Promise((resolve, reject) => {
      execFile(ytDlpPath, [
        "-x", "--audio-format", "mp3",
        "--ffmpeg-location", ffmpegPath,
        "-o", tempAudio,
        youtubeUrl
      ], (err, stdout, stderr) => {
        if (err) return reject(stderr || err);
        resolve();
      });
    });

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

    console.log("Cleaning up...");
    fs.unlinkSync(tempAudio);
    fs.unlinkSync(coverPath);

    console.log("Sending file to browser...");
    res.download(finalOutput);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running...");
});
