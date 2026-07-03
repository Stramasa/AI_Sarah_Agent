function classifyEmail(subject, body, from) {
  var prompt =
    "Classify this inbound email for Stramasa Group.\n\n" +
    "Types:\n" +
    "lead: potential new client asking about services, including hire requests on Recruitshore.\n" +
    "client: existing client or project message.\n" +
    "talent: job, internship, freelancer, or candidate applying for work.\n" +
    "spam: newsletters, promotions, account/security notices, automated no-reply messages, cold outreach, SEO spam, unrelated sales pitches, system notices.\n" +
    "unsure: genuinely unclear or risky.\n\n" +

    "Hard rules:\n" +
    "A lead is someone who wants to HIRE Stramasa - they want Stramasa to be paid to do work for them. Direction matters.\n" +
    "If the sender is instead offering, promoting, or pitching their OWN services, skills, portfolio, product, or freelance/agency work TO Stramasa, this is a vendor solicitation and must be classified as spam - even if it is phrased as 'collaboration', 'partnership', 'let's work together', 'thoughts on my portfolio', or similar soft framing. This applies no matter how relevant, professional, or well-targeted the pitch is. The test is simple: would Stramasa be the one paying, or the one being asked to pay/consider hiring the sender? If the sender would be paid or hired, it is spam, not a lead.\n" +
    "If the email is about an existing project, deliverable, campaign, content calendar, approval, revision, feedback, invoice, meeting follow-up, deadline, support request, ongoing work, monthly work, client request, or previous engagement, classify as client.\n" +
    "If the email appears to be from or forwarded from an existing client but the client is not recognized, classify as client or unsure, never lead.\n" +
    "If there is any realistic chance this is an existing client email, classify as unsure rather than lead.\n" +
    "A lead asking for case studies, references, portfolio examples, pricing, company profile, proposal, RFP response, capabilities, or previous work examples is still a lead unless it clearly refers to an existing project.\n" +
    "Website contact form submissions forwarded from requests@stramasa.com or groupleads@stramasa.com are leads unless the message is clearly spam, a vendor pitch, or an existing client project message.\n" +
    "IntroLynk contact form questions about buying leads, credits, pricing, subscriptions, registration, or how the platform works are leads unless the content itself is spam.\n" +
    "Recruitshore talent applications are talent, but Recruitshore hire/profile requests are leads.\n" +
    "Unsolicited offers to improve our SEO, sell backlinks, redesign our website, sell lead generation, sell databases, do animation/design/dev work, or send a price estimate for their services are spam unless they are clearly part of an existing conversation.\n" +
    "Calendly confirmations and bounce emails are handled before this classifier, so do not call those leads.\n\n" +

    "Return ONLY raw JSON with this exact structure:\n" +
    "{\"type\":\"lead|client|talent|spam|unsure\",\"name\":\"\",\"service_interest\":\"\",\"company\":\"\",\"reason\":\"\"}\n\n" +
    "The reason must be one short sentence explaining the classification decision.\n\n" +
    "From: " + from + "\nSubject: " + subject + "\nBody:\n" + body.substring(0, 1800);

  var response = callClaude(prompt, "claude-haiku-4-5-20251001");
  var result = JSON.parse(cleanJson(response));

  if (!result.reason) result.reason = "No reason provided by classifier.";

  return result;
}

function safeClassify(subject, body, from) {
  try {
    return classifyEmail(subject, body, from);
  } catch(e) {
    Logger.log("classifyEmail error: " + e);
    return {
      type: "unsure",
      name: "",
      service_interest: "",
      company: "",
      reason: "Classifier failed or returned invalid JSON: " + e
    };
  }
}

function analyzeEmailSender(subject, body, fromHeader) {
  var prompt =
    "Find the real external person Sarah should reply to.\n\n" +
    "Rules:\n" +
    "If forwarded by Stramasa, replyTo is the original external sender in the body.\n" +
    "If website/contact form, replyTo is the submitter email in the body.\n" +
    "Never return a @stramasa.com address as replyTo.\n\n" +
    "Return ONLY raw JSON:\n" +
    "{\"replyTo\":\"\",\"name\":\"\",\"isForward\":false,\"forwardedBy\":\"\"}\n\n" +
    "From header: " + fromHeader + "\nSubject: " + subject + "\nBody:\n" + body.substring(0, 3000);

  try {
    var result = JSON.parse(cleanJson(callClaude(prompt, "claude-haiku-4-5-20251001")));
    if (result.replyTo && isInternalEmail(result.replyTo)) result.replyTo = "";
    return result;
  } catch(e) {
    Logger.log("analyzeEmailSender error: " + e);
    var fallback = extractEmail(fromHeader);
    return {
      replyTo: isInternalEmail(fallback) ? "" : fallback,
      name: "",
      isForward: false,
      forwardedBy: ""
    };
  }
}

// ---- Plain text call (unchanged) -----------------------------------

function callClaude(userPrompt, model, systemPrompt) {
  model = model || "claude-haiku-4-5-20251001";

  if (!CONFIG.CLAUDE_API_KEY || CONFIG.CLAUDE_API_KEY === "PASTE_CLAUDE_API_KEY_HERE") {
    throw new Error("Missing CLAUDE_API_KEY Script Property");
  }

  var payload = {
    model: model,
    max_tokens: 1000,
    messages: [{ role: "user", content: userPrompt }]
  };

  if (systemPrompt) payload.system = systemPrompt;

  var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": CONFIG.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var text = response.getContentText();
  var json = JSON.parse(text);

  if (json.error) throw new Error(json.error.message);
  if (json.content && json.content[0] && json.content[0].text) return json.content[0].text;

  throw new Error("Claude unexpected response: " + text.substring(0, 200));
}

// ---- Tool-use call (new) --------------------------------------------
// Same endpoint, same API key, same everything - just adds `tools` to the
// payload and returns the tool_use blocks instead of raw text. This is a
// standard Messages API feature, not a separate Anthropic "agent" product.
//
// toolChoice: "auto" (Claude may or may not call a tool), "any" (Claude
// must call at least one of the provided tools, but may call several).
function callClaudeTools(userPrompt, tools, systemPrompt, model, toolChoice) {
  model = model || "claude-sonnet-4-6";
  toolChoice = toolChoice || "auto";

  if (!CONFIG.CLAUDE_API_KEY || CONFIG.CLAUDE_API_KEY === "PASTE_CLAUDE_API_KEY_HERE") {
    throw new Error("Missing CLAUDE_API_KEY Script Property");
  }

  var payload = {
    model: model,
    max_tokens: 1200,
    messages: [{ role: "user", content: userPrompt }],
    tools: tools,
    tool_choice: { type: toolChoice }
  };

  if (systemPrompt) payload.system = systemPrompt;

  var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": CONFIG.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var text = response.getContentText();
  var json = JSON.parse(text);

  if (json.error) throw new Error(json.error.message);
  if (!json.content) throw new Error("Claude unexpected response: " + text.substring(0, 200));

  var toolCalls = [];
  var textParts = [];

  json.content.forEach(function(block) {
    if (block.type === "tool_use") {
      toolCalls.push({ name: block.name, input: block.input || {} });
    } else if (block.type === "text") {
      textParts.push(block.text);
    }
  });

  return {
    toolCalls: toolCalls,
    text: textParts.join("\n"),
    stopReason: json.stop_reason || ""
  };
}

function cleanJson(text) {
  return (text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}