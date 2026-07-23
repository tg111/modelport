const crypto = require("crypto");

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    if (typeof part?.text === "string") return part.text;
    if (typeof part?.input_text === "string") return part.input_text;
    if (typeof part?.output_text === "string") return part.output_text;
    return "";
  }).join("");
}

function responsesToolToChatTool(tool) {
  if (!tool || tool.type !== "function") return tool;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || {}
    }
  };
}

function responsesToolChoiceToChat(choice) {
  if (!choice || typeof choice === "string") return choice;
  if (choice.type === "function") return { type: "function", function: { name: choice.name } };
  return choice;
}

function normalizeFunctionArguments(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

function responsesInputItemToMessages(item) {
  const type = item?.type || "";
  if (type === "function_call_output") {
    return [{ role: "tool", tool_call_id: item.call_id || item.id || "", content: textFromContent(item.output ?? item.content ?? item.result) }];
  }
  if (type === "function_call") {
    return [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
        type: "function",
        function: {
          name: item.name || "",
          arguments: normalizeFunctionArguments(item.arguments)
        }
      }]
    }];
  }
  if (type && type !== "message") return [];

  const role = item?.role || "user";
  const content = textFromContent(item?.content ?? item?.text ?? item?.input_text);
  if (!content && role !== "assistant") return [];
  return [{ role, content }];
}

function responsesToChatRequest(body, modelId) {
  const out = { model: modelId, messages: [] };
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.stream === true) out.stream_options = { include_usage: true };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.response_format !== undefined) out.response_format = body.response_format;
  if (body.metadata !== undefined) out.metadata = body.metadata;

  if (body.instructions) out.messages.push({ role: "system", content: String(body.instructions) });

  if (Array.isArray(body.input)) {
    for (const item of body.input) out.messages.push(...responsesInputItemToMessages(item));
  } else if (typeof body.input === "string") {
    out.messages.push({ role: "user", content: body.input });
  }

  if (Array.isArray(body.tools)) out.tools = body.tools.map(responsesToolToChatTool).filter(Boolean);
  if (body.tool_choice !== undefined) out.tool_choice = responsesToolChoiceToChat(body.tool_choice);
  return out;
}

function chatMessageToResponsesOutput(message = {}) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return message.tool_calls.map(call => ({
      type: "function_call",
      id: call.id || `fc_${crypto.randomUUID()}`,
      call_id: call.id || `call_${crypto.randomUUID()}`,
      name: call.function?.name || "",
      arguments: call.function?.arguments || "{}",
      status: "completed"
    }));
  }
  return [{
    type: "message",
    id: `msg_${crypto.randomUUID()}`,
    role: "assistant",
    content: [{ type: "output_text", text: message.content || "" }]
  }];
}

function chatToResponsesBody(chatBody, model) {
  const choice = chatBody?.choices?.[0] || {};
  const output = chatMessageToResponsesOutput(choice.message || {});
  return {
    id: chatBody?.id || `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: chatBody?.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: model || chatBody?.model || "",
    output,
    parallel_tool_calls: true,
    usage: chatBody?.usage || null
  };
}

function sseEvent(event, data) {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, "utf8");
}

function responsesCompletedEvent(responseId, model, usage = null) {
  return sseEvent("response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model,
      output: [],
      parallel_tool_calls: true,
      usage
    }
  });
}

async function* chatStreamToResponsesStream(stream, model) {
  const decoder = new TextDecoder();
  const responseId = `resp_${crypto.randomUUID()}`;
  const textItemId = `msg_${crypto.randomUUID()}`;
  let buffer = "";
  let textStarted = false;
  let usage = null;
  const toolItems = new Map();

  yield sseEvent("response.created", {
    type: "response.created",
    response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model, output: [], parallel_tool_calls: true }
  });

  function* handleData(data) {
    if (!data || data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      return;
    }

    const delta = parsed.choices?.[0]?.delta || {};
    if (parsed.usage) usage = parsed.usage;
    if (typeof delta.content === "string" && delta.content) {
      if (!textStarted) {
        textStarted = true;
        yield sseEvent("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: textItemId, type: "message", role: "assistant", content: [] } });
        yield sseEvent("response.content_part.added", { type: "response.content_part.added", item_id: textItemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
      }
      yield sseEvent("response.output_text.delta", { type: "response.output_text.delta", item_id: textItemId, output_index: 0, content_index: 0, delta: delta.content });
    }

    for (const toolDelta of delta.tool_calls || []) {
      const index = Number(toolDelta.index || 0);
      let item = toolItems.get(index);
      if (!item) {
        item = { id: toolDelta.id || `fc_${crypto.randomUUID()}`, call_id: toolDelta.id || `call_${crypto.randomUUID()}`, name: toolDelta.function?.name || "", arguments: "" };
        toolItems.set(index, item);
        yield sseEvent("response.output_item.added", { type: "response.output_item.added", output_index: index, item: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name, arguments: "", status: "in_progress" } });
      }
      if (toolDelta.function?.name) item.name = toolDelta.function.name;
      if (typeof toolDelta.function?.arguments === "string" && toolDelta.function.arguments) {
        item.arguments += toolDelta.function.arguments;
        yield sseEvent("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: toolDelta.function.arguments });
      }
    }
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const eventText of events) {
      const lines = eventText.split(/\r?\n/).filter(line => line.startsWith("data:"));
      const data = lines.map(line => line.slice(5).trim()).join("\n").trim();
      yield* handleData(data);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const lines = buffer.split(/\r?\n/).filter(line => line.startsWith("data:"));
    const data = lines.map(line => line.slice(5).trim()).join("\n").trim();
    yield* handleData(data);
  }

  if (textStarted) {
    yield sseEvent("response.output_text.done", { type: "response.output_text.done", item_id: textItemId, output_index: 0, content_index: 0, text: "" });
    yield sseEvent("response.content_part.done", { type: "response.content_part.done", item_id: textItemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
    yield sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: textItemId, type: "message", role: "assistant", content: [] } });
  }
  for (const [index, item] of toolItems) {
    yield sseEvent("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: index, arguments: item.arguments });
    yield sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: index, item: { type: "function_call", id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments, status: "completed" } });
  }
  yield responsesCompletedEvent(responseId, model, usage);
  yield Buffer.from("data: [DONE]\n\n", "utf8");
}

module.exports = {
  responsesToChatRequest,
  chatToResponsesBody,
  sseEvent,
  responsesCompletedEvent,
  chatStreamToResponsesStream
};
