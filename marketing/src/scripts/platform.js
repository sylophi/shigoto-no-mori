// The platform whose download the page offers first: Windows on
// Windows, the Mac anywhere else, told apart as the app's viewerOs
// (@shigomori/ui's platform.ts) does. Loaded blocking in <head>, so only
// that platform's buttons and notes paint (global.css, [data-for]).
document.documentElement.dataset.platform = navigator.platform.startsWith("Win")
  ? "windows"
  : "mac";
