import { Array as Arr, Order } from "effect";

// Inside the sandbox, before a record leaves it: masks literal strings and
// the values of named env vars. Pure, so it's the same everywhere.

/** What every masked occurrence becomes. */
export const REDACTED = "[REDACTED]";

const LONGEST_FIRST = Order.mapInput(
  Order.reverse(Order.number),
  (secret: string) => secret.length,
);

/** A function that masks every secret in a string. */
export type Redact = (text: string) => string;

/**
 * A secret as it appears literally, and as it appears inside a JSON string
 * (tool-call args and transcript lines are JSON), where `"`, `\` and control
 * characters are escaped.
 */
const forms = (secret: string): readonly string[] => {
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
};

/**
 * The redactor for `values` and the values `envVars` have in `env`, masking
 * each literally and JSON-escaped. Longer secrets are masked first, so one
 * that contains another is masked whole. Empty strings and unset vars mask
 * nothing.
 */
export const redactor = (
  redaction: {
    readonly values: readonly string[];
    readonly envVars: readonly string[];
  },
  env: Readonly<Record<string, string | undefined>>,
): Redact => {
  const secrets = Arr.sort(
    [...redaction.values, ...redaction.envVars.map((name) => env[name] ?? "")]
      .filter((secret) => secret !== "")
      .flatMap((secret) => forms(secret)),
    LONGEST_FIRST,
  );
  return (text) =>
    secrets.reduce(
      (masked, secret) => masked.replaceAll(secret, REDACTED),
      text,
    );
};
