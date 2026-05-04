import type {
  AgentProviderAdapter,
  ProviderAdapterInput,
  ProviderAdapterOutput,
} from "./AgentProviderAdapter.js";
import { enabledCommands, enabledSkills } from "./adapterFormatting.js";

interface PiRegistryCard {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
}

interface PiRegistry {
  readonly mode: PiRegistryCard;
  readonly skills: PiRegistryCard[];
  readonly commands: PiRegistryCard[];
}

export class PiAdapter implements AgentProviderAdapter {
  readonly id = "pi" as const;

  async materialize(
    input: ProviderAdapterInput,
  ): Promise<ProviderAdapterOutput> {
    // Phase 5 stabilizes Sandcastle's Pi registry shape; verify against Pi's
    // external convention during Phase 6 hosted-web work.
    const registry: PiRegistry = {
      mode: card(input.deck.mode),
      skills: enabledSkills(input.deck.skills).map(card),
      commands: enabledCommands(input.deck.commands).map(card),
    };
    return {
      files: [
        {
          relativePath: ".pi/registry.json",
          content: `${JSON.stringify(registry, null, 2)}\n`,
        },
        {
          relativePath: ".pi/prompt.md",
          content: `${input.deck.mode.body.trim()}\n`,
        },
      ],
      cleanupPaths: [".pi/"],
    };
  }
}

const card = (input: {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
}): PiRegistryCard => ({
  slug: input.slug,
  title: input.title,
  body: input.body.trim(),
});
