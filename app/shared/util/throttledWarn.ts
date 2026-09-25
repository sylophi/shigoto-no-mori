// A console.warn for a complaint a chatty stream could repeat once per
// frame (a throwing push handler, a frame for no attached channel):
// it logs the 1st occurrence and then one in every fifty (the 51st,
// the 101st, ...), never one line per event. The message is a thunk
// handed the running count, so each logged line can say how many so
// far, and the text is only built on the occurrences that log.
export function createThrottledWarn(): (
  message: (count: number) => string,
) => void {
  let count = 0;
  return (message) => {
    count += 1;
    if (count % 50 === 1) console.warn(message(count));
  };
}
