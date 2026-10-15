import { AGENT_CAPABLE } from "../utils/flags.ts";
import type { Command } from "commander";
import { envelopeSchema, coreResultSchemas } from "../services/agent-contract.ts";
import { emitJson } from "../utils/output.ts";

export function registerAgentCommand(program: Command): void {
  program.command("agent").description("Discover the versioned automation contract")
    .command("schema").description("Print the envelope schema and managed command paths")
    .action(() => {
      const paths: string[][] = [];
      const inputs: Array<{
        path: string[];
        aliases: string[];
        arguments: Array<{ name: string; required: boolean; variadic: boolean; choices?: string[] }>;
        options: Array<{ name: string; short?: string; long?: string; takesValue: boolean; optionalValue: boolean; choices?: string[] }>;
      }> = [];
      function visit(parent: Command, prefix: string[]): void {
        for (const command of parent.commands) {
          if (prefix.length === 0 && !AGENT_CAPABLE.has(command.name())) continue;
          const path = [...prefix, command.name()];
          paths.push(path);
          inputs.push({
            path,
            aliases: command.aliases(),
            arguments: command.registeredArguments.map(argument => ({ name: argument.name(), required: argument.required, variadic: argument.variadic, ...(argument.argChoices ? { choices: argument.argChoices } : {}) })),
            options: command.options.filter(option => !option.hidden).map(option => ({ name: option.attributeName(), ...(option.short ? { short: option.short } : {}), ...(option.long ? { long: option.long } : {}), takesValue: option.required || option.optional, optionalValue: option.optional, ...(option.argChoices ? { choices: option.argChoices } : {}) })),
          });
          visit(command, path);
        }
      }
      visit(program, []);
      emitJson({ envelope: envelopeSchema, supportedCommandPaths: paths, inputs, unmanagedEscapes: ["ggh git", "ggh gh", "ggh --"], unsupportedDomains: program.commands.filter(command => !AGENT_CAPABLE.has(command.name()) && !["git", "gh"].includes(command.name())).map(command => command.name()), coreResultSchemas });
    });
}
