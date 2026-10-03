// A tiny in-memory stand-in for the parts of rippled the adapter uses. Tests only.
import { createHash } from "node:crypto";
import type { Client } from "xrpl";

type Tx = Record<string, unknown> & { TransactionType: string; Account: string };
interface Entry {
  hash: string;
  tx: Tx;
  meta: { TransactionResult: string; AffectedNodes: unknown[] };
  close_time_iso: string;
}

export function fakeLedger() {
  const escrows = new Map<string, Record<string, unknown>>();
  const history = new Map<string, Entry[]>();
  const byHash = new Map<string, Entry>();
  let sequence = 100;
  const state = { closeTime: 800_000_000, nextResult: "tesSUCCESS", submitted: [] as Tx[] };

  const notFound = (error: string) => Object.assign(new Error(error), { data: { error } });
  const entryResult = (e: Entry) => ({
    hash: e.hash,
    tx_json: e.tx,
    meta: e.meta,
    close_time_iso: e.close_time_iso,
  });
  const record = (entry: Entry, accounts: unknown[]) => {
    byHash.set(entry.hash, entry);
    for (const a of new Set(accounts.filter(Boolean) as string[])) {
      history.set(a, [...(history.get(a) ?? []), entry]);
    }
  };

  const client = {
    async request(req: {
      command: string;
      escrow?: { owner: string; seq: number };
      account?: string;
      transaction?: string;
    }) {
      switch (req.command) {
        case "ledger":
          return { result: { ledger: { close_time: state.closeTime } } };
        case "ledger_entry": {
          const node = escrows.get(`${req.escrow?.owner}:${req.escrow?.seq}`);
          if (!node) throw notFound("entryNotFound");
          return { result: { node } };
        }
        case "account_tx": {
          const txs = [...(history.get(req.account ?? "") ?? [])].reverse();
          return {
            result: {
              transactions: txs.map((e) => ({ validated: true, ...entryResult(e) })),
            },
          };
        }
        case "tx": {
          const e = byHash.get(req.transaction ?? "");
          if (!e) throw notFound("txnNotFound");
          return { result: { validated: true, ...entryResult(e) } };
        }
      }
      throw new Error(`unexpected command ${req.command}`);
    },

    async submitAndWait(input: Tx) {
      const tx: Tx = { ...input, Sequence: sequence++ };
      state.submitted.push(tx);
      const hash = createHash("sha256").update(JSON.stringify(tx)).digest("hex").toUpperCase();
      const entry: Entry = {
        hash,
        tx,
        meta: { TransactionResult: state.nextResult, AffectedNodes: [] },
        close_time_iso: new Date((state.closeTime + 946_684_800) * 1000).toISOString(),
      };
      if (state.nextResult !== "tesSUCCESS") {
        state.nextResult = "tesSUCCESS";
        return { result: entryResult(entry) };
      }
      const accounts: unknown[] = [tx.Account];
      if (tx.TransactionType === "EscrowCreate") {
        escrows.set(`${tx.Account}:${tx.Sequence}`, {
          LedgerEntryType: "Escrow",
          Account: tx.Account,
          Destination: tx.Destination,
          Amount: tx.Amount,
          Condition: tx.Condition,
          CancelAfter: tx.CancelAfter,
        });
        accounts.push(tx.Destination);
      } else if (tx.TransactionType === "EscrowFinish" || tx.TransactionType === "EscrowCancel") {
        const key = `${tx.Owner}:${tx.OfferSequence}`;
        const node = escrows.get(key);
        escrows.delete(key);
        entry.meta.AffectedNodes.push({
          DeletedNode: { LedgerEntryType: "Escrow", LedgerIndex: "00", FinalFields: node },
        });
        accounts.push(tx.Owner, node?.Destination);
      }
      record(entry, accounts);
      return { result: entryResult(entry) };
    },
  };

  return { client: client as unknown as Client, state };
}
