// The fd number stdin's reader gets in Bun. Bun's process.stdin dups
// fd 0 when a reader first attaches, as the menu shows, and keeps that
// fd for every later reader; the dup takes the lowest free number.
// Under load the menu's dup can take a number the git children the
// command just ran are giving back, and that fd is then closed under
// the reader: Bun's "EBADF: bad file descriptor, fstat" as the reader
// starts, or a reader that never wakes while the key sits in the
// terminal's queue. A late second close of the reused number is the
// likely cause; which close it is isn't known.
// So the binary holds a number from its start, before any child runs,
// and gives it back just as the menu attaches: the lowest free number
// is then one no child's pipe can have had, and the dup takes it.
// Nothing reads stdin before a menu shows, so typeahead stays the
// shell's. A workaround for Bun: a Bun bump runs `pnpm -C packages/cli
// under-load` before it lands (README.md).
import { closeSync, openSync } from "node:fs";

let held: number | null = null;
let attached = false;

// As the binary starts, at a terminal.
export const holdStdinFd = () => {
  if (process.stdin.isTTY !== true) return;
  held = openSync("/dev/null", "r");
};

const nothing = () => {};

// Gives the held number back and has Bun make its dup at once, in one
// synchronous step: anything opened between the two would take the
// number instead. A 'readable' listener added and removed makes the
// dup; ink's own listener, as the menu shows, then reads through it.
export const attachStdin = () => {
  if (held === null) return;
  closeSync(held);
  held = null;
  attached = true;
  process.stdin.on("readable", nothing);
  process.stdin.removeListener("readable", nothing);
  process.stdin.pause();
};

// Before the terminal goes to another program (handOver): a reader a
// menu attached keeps a read pending on its dup, and once an
// interactive shell takes the terminal's foreground group that read
// fails with EIO, which Bun throws. Destroying the reader ends that
// read (fd 0 stays open), and the program reads the terminal alone.
export const releaseStdin = () => {
  if (!attached) return;
  attached = false;
  process.stdin.destroy();
};
