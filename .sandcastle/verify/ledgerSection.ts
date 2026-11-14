/** One section of the ledger: its LEAK lines and its notes. */
export interface Section {
  readonly title: string;
  readonly leaks: string[];
  readonly notes: string[];
}
