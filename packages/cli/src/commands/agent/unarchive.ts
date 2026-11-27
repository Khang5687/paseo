import type { Command } from "commander";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import { fetchAllAgents } from "../../utils/agent-directory.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface AgentUnarchiveResult {
  agentId: string;
  status: "unarchived" | "active";
  workspaceRestored: boolean;
  warning: string | null;
}

const unarchiveSchema: OutputSchema<AgentUnarchiveResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "WORKSPACE RESTORED", field: "workspaceRestored" },
    { header: "WARNING", field: "warning" },
  ],
};

export async function runUnarchiveCommand(
  agentIdArg: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AgentUnarchiveResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    // COMPAT(agentUnarchive): added in v0.15.0, remove gate after 2027-05-02.
    if (client.getLastServerInfoMessage()?.features?.agentUnarchive !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to unarchive agents.",
      } satisfies CommandError;
    }
    const agentId = resolveAgentId(
      agentIdArg,
      await fetchAllAgents(client, { filter: { includeArchived: true } }),
    );
    if (!agentId) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls -a" to list archived agents',
      } satisfies CommandError;
    }
    const result = await client.unarchiveAgent(agentId);
    return {
      type: "single",
      data: {
        agentId,
        status: result.wasArchived ? "unarchived" : "active",
        workspaceRestored: result.workspaceRestored,
        warning: result.warning,
      },
      schema: unarchiveSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
