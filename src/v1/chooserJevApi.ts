import { Either, Schema } from "effect";

// One request to TypeSafe's System One API, with one Choice question, as its
// docs describe it (https://docs.typesafe.ai/api/system-one): POST
// /v1/systemone with a bearer key, a `model`, a `state` and named
// `questions`; the answer comes back under the question's name.

/** The System One endpoint. */
export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

/** The question's name in the request, and its answer's in the response. */
const QUESTION = "next_ticket";

/** Where and how a chooser calls Jev. */
export interface JevClient {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch: typeof globalThis.fetch;
}

/** One Choice question about `state`: which of `criteria`'s options applies. */
export interface JevChoiceQuestion {
  readonly state: unknown;
  readonly instructions: string;
  /** Each option's name and what it means. */
  readonly criteria: Readonly<Record<string, string>>;
}

const ChoiceResponse = Schema.Struct({
  answers: Schema.Struct({
    [QUESTION]: Schema.Struct({
      type: Schema.Literal("choice"),
      choice: Schema.String,
    }),
  }),
});

/** The first 500 characters of an error body: enough to say what went wrong. */
const excerpt = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500);
};

/**
 * Asks Jev one Choice question and resolves with the option it chose.
 * Rejects on a non-2xx status, naming it, or on a response that isn't a
 * Choice answer. The key goes in the `Authorization` header only.
 */
export const askJev = async (
  client: JevClient,
  question: JevChoiceQuestion,
): Promise<string> => {
  const response = await client.fetch(SYSTEM_ONE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: client.model,
      state: question.state,
      questions: {
        [QUESTION]: {
          type: "choice",
          instructions: question.instructions,
          criteria: question.criteria,
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `jevChooser: TypeSafe answered ${response.status}: ${await excerpt(response)}`,
    );
  }
  const decoded = Schema.decodeUnknownEither(ChoiceResponse)(
    await response.json(),
  );
  if (Either.isLeft(decoded)) {
    throw new Error(
      `jevChooser: TypeSafe's response isn't a choice answer: ${decoded.left.message}`,
    );
  }
  return decoded.right.answers[QUESTION].choice;
};
