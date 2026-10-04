/** Shared by the tucked-away question control and the server. */
export const ASK_PRESETS = {
  brief: {
    label: 'Brief answer',
    prompt: 'Answer the current handwritten message directly. Prioritize a question or unfinished equation over older greetings. For an idea or draft, give one concrete next step; for a greeting, reply naturally. If there is no clear task, ask one short question about what I want to do.',
  },
  hint: {
    label: 'Hint',
    prompt: 'Give just one small hint that helps me work this out myself. Do not reveal the full solution or final answer.',
  },
  next: {
    label: 'Next step',
    prompt: 'Suggest only the single next step for the work in my handwriting or sketch. Do not give a whole plan.',
  },
  check: {
    label: 'Check my work',
    prompt: 'Check the reasoning or content of my work, not the handwriting. Point out only the most important mistake and its correction, or briefly confirm that it is correct. Do not invent a penmanship lesson.',
  },
} as const

export type AskPreset = keyof typeof ASK_PRESETS
export const MAX_ANSWER_CHARS = 180
export const CANVAS_INPUT_RULES = `The handwritten words are my messages to you, as if I had typed them. Respond to their meaning, not their appearance. Never critique letter shapes, slant, stroke quality, spelling, or punctuation unless I explicitly ask. Printed assistant replies are only context: do not review them or continue their observational style.`
export const CANVAS_REPLY_RULES = `Give only the answer or one useful next action. Usually 2–12 words; at most 25 words and under ${MAX_ANSWER_CHARS} characters. Use one short sentence at most; a number, equation, or brief phrase alone is fine. Do not pad a simple answer with coaching, praise, an explanation, or an offer to help. Plain text only, no markdown, headings, or lists.`

/** Apply brevity even when a typed question or a later conversation turn asks for more. */
export function buildAskPrompt(question: unknown, preset: unknown = 'brief') {
  const mode = typeof preset === 'string' && Object.hasOwn(ASK_PRESETS, preset) ? preset as AskPreset : 'brief'
  const typed = typeof question === 'string' ? question.trim().slice(0, 2000) : ''
  return `This is my current canvas screenshot.
${CANVAS_INPUT_RULES}
${ASK_PRESETS[mode].prompt}
${typed ? `My question: ${typed}\n` : ''}${CANVAS_REPLY_RULES}`
}
