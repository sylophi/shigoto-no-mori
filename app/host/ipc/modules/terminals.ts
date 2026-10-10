import { terminalsContract } from "@shigomori/contracts/modules/terminals";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Stream from "effect/Stream";
import * as Terminals from "@host/lib/terminals/Terminals";
import type * as Views from "@host/lib/views";
import type { HandlerContext } from "@shared/ipc/transport";

export const terminalsViews: ViewHandlers<
  typeof terminalsContract,
  Views.Services
> = {
  list: () =>
    Terminals.stream((terminals) =>
      terminals.list.pipe(Stream.map((list) => ({ terminals: list }))),
    ),
  attach: ({ terminalId, after }) =>
    Terminals.stream((terminals) => terminals.attach(terminalId, after)),
};

export const terminalsHandlers: Handlers<
  typeof terminalsContract,
  HandlerContext
> = {
  open: async ({ owner, size }) => {
    const { terminalId } = await Terminals.call((terminals) =>
      terminals.open({ owner, size }),
    );
    return { terminalId };
  },
  close: ({ terminalId }) =>
    Terminals.call((terminals) => terminals.close(terminalId)),
  write: ({ terminalId, data }) =>
    Terminals.call((terminals) => terminals.write(terminalId, data)),
  resize: ({ terminalId, cols, rows }) =>
    Terminals.call((terminals) => terminals.resize(terminalId, { cols, rows })),
};
