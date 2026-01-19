async function download() {
  const yt = document.getElementById("yt").value;
  const search = document.getElementById("search").value;
  const status = document.getElementById("status");

  status.textContent = "Downloading...";

  const res = await fetch("/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ youtubeUrl: yt, searchQuery: search })
  });

  if (!res.ok) {
    status.textContent = "Error downloading";
    return;
  }

  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "song.mp3";
  a.click();

  status.textContent = "Done!";
}
