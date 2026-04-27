import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceFrameworkCoreContractPath,
  FINANCE_FRAMEWORK_CORE_DOMAINS,
  parseFinanceFrameworkCoreContractArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const FinanceFrameworkCoreInspectSchema = Type.Object({
  domain: Type.Optional(stringEnum(FINANCE_FRAMEWORK_CORE_DOMAINS)),
});

export function createFinanceFrameworkCoreInspectTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Framework Core Inspect",
    name: "finance_framework_core_inspect",
    description:
      "Inspect the durable finance framework core contract across domains or for one specific domain. This is read-only and exposes bounded cognition state only.",
    parameters: FinanceFrameworkCoreInspectSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const domain = readStringParam(params, "domain") as
        | (typeof FINANCE_FRAMEWORK_CORE_DOMAINS)[number]
        | undefined;

      const contractRelPath = buildFinanceFrameworkCoreContractPath();
      const contractAbsPath = path.join(workspaceDir, contractRelPath);

      let contractContent: string;
      try {
        contractContent = await fs.readFile(contractAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            reason: "finance_framework_core_contract_missing",
            contractPath: contractRelPath,
            action:
              "Record at least one finance framework core domain entry before inspecting the framework contract.",
          });
        }
        throw error;
      }

      const parsedContract = parseFinanceFrameworkCoreContractArtifact(contractContent);
      if (!parsedContract) {
        return jsonResult({
          ok: false,
          reason: "finance_framework_core_contract_malformed",
          contractPath: contractRelPath,
          action:
            "Repair or archive the malformed finance framework core contract before retrying finance_framework_core_inspect.",
        });
      }

      if (domain) {
        const entry = parsedContract.entries.find((candidate) => candidate.domain === domain);
        if (!entry) {
          return jsonResult({
            ok: false,
            reason: "finance_framework_core_domain_not_found",
            contractPath: contractRelPath,
            domain,
            availableDomains: parsedContract.entries.map((candidate) => candidate.domain),
            action:
              "Inspect the current framework domains first, then record the missing domain entry before retrying finance_framework_core_inspect.",
          });
        }
        return jsonResult({
          ok: true,
          contractPath: contractRelPath,
          updatedAt: parsedContract.updatedAt,
          domainCount: parsedContract.entries.length,
          entry,
        });
      }

      return jsonResult({
        ok: true,
        contractPath: contractRelPath,
        updatedAt: parsedContract.updatedAt,
        domainCount: parsedContract.entries.length,
        entries: parsedContract.entries,
      });
    },
  };
}
