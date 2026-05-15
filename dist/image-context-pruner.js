// src/image-context-pruner.ts
function image_context_pruner_default(pi) {
  pi.on("context", async (event, _ctx) => {
    const messages = event.messages;
    let lastUserWithImageIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const hasImage = msg.content.some(
          (block) => block.type === "image" || block.type === "image_url"
        );
        if (hasImage) {
          lastUserWithImageIdx = i;
          break;
        }
      }
    }
    const result = messages.map((msg, i) => {
      if (i === lastUserWithImageIdx) return msg;
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const hasImage = msg.content.some(
          (block) => block.type === "image" || block.type === "image_url"
        );
        if (hasImage) {
          return {
            ...msg,
            content: msg.content.map((block) => {
              if (block.type === "image" || block.type === "image_url") {
                return { type: "text", text: "[image \u2014 already processed in earlier turn]" };
              }
              return block;
            })
          };
        }
      }
      return msg;
    });
    return { messages: result };
  });
}
export {
  image_context_pruner_default as default
};
//# sourceMappingURL=image-context-pruner.js.map
