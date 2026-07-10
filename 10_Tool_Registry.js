// ============================================================
// SARAH AI - Tool Registry
// Replaces the old Console/Managed Agent integration.
//
// This file holds the Claude tool definitions (JSON schemas) and
// a small dispatcher. Nothing here talks to any Anthropic "agent"
// product - these are plain tool_use definitions passed to the
// standard /v1/messages endpoint via callClaudeTools() in
// 06_Claude_Classification.js. Claude decides which tool(s) to
// call; Apps Script executes them. No MCP, no vaults, no agent IDs.
// ============================================================

// ---- Lead tools -------------------------------------------------

var LEAD_TOOLS = [
  {
    name: "reply_to_lead",
    description:
      "Send a reply to an external lead (new inbound lead or a lead replying to a previous Sarah message). " +
      "Use the provided calendar slot block verbatim inside body - never invent dates or times.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Reply subject line, no markdown, no quotes." },
        body: { type: "string", description: "Plain text email body only. No markdown, no bullets except slot lines already provided, no em dashes. Sign off exactly: Sarah | {brand}." }
      },
      required: ["subject", "body"]
    }
  },
  {
    name: "book_meeting",
    description:
      "Create and send a real Google Calendar invite for a confirmed meeting time, on the shared stramasapro calendar, " +
      "with the internal team cc'd and the lead as a guest. Only call this if the lead's message clearly and " +
      "unambiguously confirms one of the exact coded slots offered - never for a vague, partial, or unconfirmed time, " +
      "and never for a time that isn't one of the offered slots. chosen_slot must be copied character-for-character " +
      "from the offered slot list. Always also call reply_to_lead in the same turn, and make sure the reply text " +
      "confirms the same time as chosen_slot so the email and the invite agree.",
    input_schema: {
      type: "object",
      properties: {
        chosen_slot: { type: "string", description: "Exact copy of the confirmed slot label from the offered list, e.g. 'Mon 6 Jul at 9:00AM ET'." },
        meeting_title: { type: "string", description: "Short meeting title, e.g. 'Stramasa Intro Call - Acme Corp'." },
        additional_guests: { type: "array", items: { type: "string" }, description: "Any extra email addresses the lead explicitly asked to include as guests (e.g. a colleague). Do not add anyone the lead did not explicitly mention." }
      },
      required: ["chosen_slot"]
    }
  }
];

// ---- Client / PM tools -------------------------------------------

var CLIENT_TOOLS = [
  {
    name: "log_client_update",
    description:
      "Record what happened in this client email into internal tracking (Client Directory + PM sheet). " +
      "Sarah never replies to clients directly - this only updates internal records. Call this for every client email.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        project: { type: "string" },
        team_owner: { type: "string", description: "Best-guess owner if known, otherwise leave blank." },
        deadline: { type: "string" },
        next_action: { type: "string" },
        blocker: { type: "string" },
        summary: { type: "string", description: "One short sentence, for the PM spreadsheet." },
        action_type: { type: "string", enum: ["log_only", "add_next_action", "update_project"] }
      },
      required: ["client_name", "summary", "action_type"]
    }
  },
  {
    name: "notify_team_member",
    description:
      "Send an internal email to a Stramasa team member because they need to actually do work in response to this client email. " +
      "Only call this if real action is needed - not for purely informational emails (thanks, acknowledged, received). " +
      "Use Sang for operational execution, PM, scheduling, coordination, admin. Use Eimee for creative work. " +
      "Use Pepijn only for strategy, pricing, scope, complaints, legal, finance, or unclear ownership.",
    input_schema: {
      type: "object",
      properties: {
        owner_name: { type: "string" },
        reason: { type: "string", description: "Why this person needs to act, in one sentence." }
      },
      required: ["owner_name", "reason"]
    }
  },
  {
    name: "escalate_to_manager",
    description:
      "Forward this email to Pepijn because ownership/responsibility is unclear, or the situation is risky/sensitive " +
      "and needs human judgment before anything else happens.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" }
      },
      required: ["reason"]
    }
  }
];

// ---- Generic dispatcher -------------------------------------------
// executors is a map: { toolName: function(input) {...} }
// Runs every tool_use block Claude returned, in order, and collects results.
function dispatchToolCalls(toolCalls, executors) {
  var results = [];

  (toolCalls || []).forEach(function(call) {
    var fn = executors[call.name];

    if (!fn) {
      Logger.log("DISPATCH: no executor registered for tool '" + call.name + "'");
      results.push({ tool: call.name, ok: false, error: "No executor registered" });
      return;
    }

    try {
      var out = fn(call.input || {});
      results.push({ tool: call.name, ok: true, output: out });
    } catch (e) {
      Logger.log("DISPATCH ERROR in tool '" + call.name + "': " + e);
      results.push({ tool: call.name, ok: false, error: String(e) });
    }
  });

  return results;
}