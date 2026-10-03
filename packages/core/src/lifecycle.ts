export type JobState =
  "quoted" | "paid" | "escrowed" | "delivered" | "released" | "refunded" | "expired";

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  quoted: ["paid", "escrowed", "expired"],
  paid: ["delivered", "refunded"],
  escrowed: ["delivered", "refunded"],
  delivered: ["released", "refunded"],
  released: [],
  refunded: [],
  expired: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal job transition ${from} -> ${to}`);
  }
}

export function isTerminal(state: JobState): boolean {
  return TRANSITIONS[state].length === 0;
}
