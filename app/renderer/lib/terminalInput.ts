// A terminal's input on its way to the PTY (TerminalView's onInput). A
// call past the largest frame a link takes (1 MiB,
// host/socket/boundedMessages.ts) closes the link and is lost, so a
// long paste goes as one write per piece, all sent at once and so in
// order with the keys typed after it. A piece of 2^18 UTF-16 code units
// is at most 768 KiB of UTF-8, and no cut parts a surrogate pair.
const PIECE_UNITS = 1 << 18;

export function inputPieces(data: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (data.length - start > PIECE_UNITS) {
    let end = start + PIECE_UNITS;
    const last = data.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(data.slice(start, end));
    start = end;
  }
  pieces.push(data.slice(start));
  return pieces;
}
