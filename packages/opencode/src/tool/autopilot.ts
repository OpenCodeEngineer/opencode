import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { type SessionID, MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./autopilot-exit.txt"

async function getLastModel(sessionID: SessionID) {
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

export const AutopilotExitTool = Tool.define("autopilot_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "autopilot_exit",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })
    const model = await getLastModel(ctx.sessionID)
    const msg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: ctx.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model,
    }
    await Session.updateMessage(msg)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: "Autopilot completed. Briefly summarize what was accomplished.",
      synthetic: true,
    } satisfies MessageV2.TextPart)
    return {
      title: "Exiting autopilot",
      output: "Autopilot complete. Switching to build mode.",
      metadata: {},
    }
  },
})
