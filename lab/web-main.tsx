// Web-shell lab entry: the REAL web app tree (web/app/boot) on the
// fixture bridge, with this page posing as an enrolled browser device.
// Same pose params as the desktop lab entry (?theme, ?doubutsu,
// ?peers) — the route comes from the path itself, since the web router
// rides real browser history.
import { installWebBridge } from "./webInstall";

const pose = new URLSearchParams(location.search);
const theme = pose.get("theme") === "dark" ? "dark" : "light";
const doubutsu = pose.get("doubutsu") !== "0";
localStorage.setItem("shigomori.theme", theme);
localStorage.setItem("shigomori.doubutsu", String(doubutsu));
localStorage.setItem(
  "sm.lab.clientConfig",
  JSON.stringify({ theme, doubutsu }),
);
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
document.documentElement.classList.toggle("doubutsu", doubutsu);

installWebBridge();

void import("../web/app/boot");
