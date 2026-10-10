import { terminalsContract } from "@shigomori/contracts/modules/terminals";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Terminals } from "@host/lib/terminals/Terminals";
import type { HandlerContext } from "@shared/ipc/transport";

export const terminalsViews: ViewHandlers<typeof terminalsContract, Terminals> =
  {
    list: () =>
      Stream.unwrap(
        Effect.map(Terminals, (terminals) =>
          terminals.list.pipe(Stream.map((list) => ({ terminals: list }))),
        ),
      ),
    attach: ({ terminalId, after }) =>
      Stream.unwrap(
        Effect.map(Terminals, (terminals) =>
          terminals.attach(terminalId, after),
        ),
      ),
  };

export const terminalsHandlers = {
  open: ({ owner, size }) =>
    Effect.flatMap(Terminals, (terminals) =>
      terminals.open({ owner, size }),
    ).pipe(Effect.map(({ terminalId }) => ({ terminalId }))),
  close: ({ terminalId }) =>
    Effect.flatMap(Terminals, (terminals) => terminals.close(terminalId)),
  write: ({ terminalId, data }) =>
    Effect.flatMap(Terminals, (terminals) => terminals.write(terminalId, data)),
  resize: ({ terminalId, cols, rows }) =>
    Effect.flatMap(Terminals, (terminals) =>
      terminals.resize(terminalId, { cols, rows }),
    ),
} satisfies EffectHandlers<typeof terminalsContract, HandlerContext, Terminals>;
