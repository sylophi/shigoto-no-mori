// Starts stdin's reader as the binary starts, before any command runs a
// child process. Bun's process.stdin dups fd 0 when a reader first
// attaches and keeps that fd for every later reader. Attached first by
// the menu, the dup took the lowest free fd number, often one the
// stdio of the git children the command had just run was giving back,
// and under load that fd was then closed under the reader: Bun's
// "EBADF: bad file descriptor, fstat" as the reader started, or a
// reader that never woke while the key sat in the terminal's queue
// (V3.md, Robustness). The fd table showed those children's sockets
// closing as the menu attached, so a late second close of a reused
// number is the likely cause; which close it is wasn't caught. Taken
// here, the dup's number is one no child's pipe can have had. The
// reader reads nothing until a menu listens, so a command reading
// /dev/stdin still gets all of it. A workaround for Bun: a Bun bump
// re-runs the at-a-terminal cases under load before it lands.
const nothing = () => {};

export const startStdinReader = () => {
  if (process.stdin.isTTY !== true) return;
  process.stdin.on("readable", nothing);
  process.stdin.removeListener("readable", nothing);
  process.stdin.pause();
  process.stdin.unref();
};
