// Pause the drifting wallpaper of every band that is off screen, so a
// page nobody is scrolling stops drawing frames. Without this script
// the wallpapers simply keep drifting.
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    entry.target.classList.toggle("wall-idle", !entry.isIntersecting);
  }
});
for (const band of document.querySelectorAll("[data-wall]")) {
  observer.observe(band);
}
