import { codeReview } from "./codeReview.js";
import { codebaseDesign } from "./codebaseDesign.js";
import { implement } from "./implement.js";
import { pr } from "./pr.js";
import { tdd } from "./tdd.js";

/** Every skill mirrored from upstream, for checking the mirror. */
export const MIRRORED_SKILLS = {
  implement,
  tdd,
  codebaseDesign,
  codeReview,
  pr,
} as const;
