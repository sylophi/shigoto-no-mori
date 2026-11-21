// The platform whose download the page offers first: Windows on
// Windows, the Mac anywhere else. Windows is told by the test the app's
// viewerOs uses (@shigomori/ui's platform.ts). Loaded blocking in <head>, so only
// that platform's buttons and notes paint (global.css, [data-for]).
document.documentElement.dataset.platform = navigator.platform.startsWith("Win")
  ? "windows"
  : "mac";
