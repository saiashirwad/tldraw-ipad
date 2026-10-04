export const MAX_ANSWER_CHARS = 500
export const CANVAS_INPUT_RULES = `The handwritten words are my messages to you, as if I had typed them. Respond to their meaning, not their appearance. Read ordinary handwriting variations naturally. Never critique letter shapes, slant, stroke quality, spelling, or punctuation unless I explicitly ask. Use only the current image to identify the question. Ignore earlier screenshots. First identify the marked handwritten question. Earlier printed replies are context only when that question explicitly refers to them; they are never the question to answer.`
export const CANVAS_REPLY_RULES = `Give only the answer. A number or equation is enough for simple arithmetic. For a definition or conceptual question, give a useful explanation in 1–3 short sentences, at most 60 words and under ${MAX_ANSWER_CHARS} characters. Do not pad a simple answer with coaching, praise, or an offer to help. Plain text only, no markdown, headings, or lists.`
export const QUESTION_TARGET_PROMPT = `The red box marks the handwritten question mark ending the question you must answer. Find the handwritten words immediately to the LEFT of that mark on the same line or lines. Transcribe those words first, without substituting an earlier question or copying a printed answer. Answer that transcription. Use only this current image. Only if the transcribed question refers to earlier writing (for example, "his age" or an arrow), use that writing to resolve the reference. Ignore unrelated equations, other questions, and printed replies. The red box is a targeting aid, not part of the handwriting. Do not mention the box or comment on spelling.`
export const QUESTION_ANSWER_PROMPT = `${QUESTION_TARGET_PROMPT}\nFirst transcribe the handwritten question ending at the boxed question mark, then answer that question. Return exactly one JSON object with two nonempty string fields: {"question":"the question you read","answer":"your answer"}. The answer field contains plain text. No markdown fences or text outside the JSON object.`

export function parseQuestionAnswer(reply: string): { question: string; answer: string } {
  const text = reply.trim().replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i, '$1')
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error('The answer could not be read. Your ? is still there.') }
  if (!value || typeof value !== 'object' || !('question' in value) || typeof value.question !== 'string' || !value.question.trim() ||
    !('answer' in value) || typeof value.answer !== 'string' || !value.answer.trim()) {
    throw new Error('The model did not identify and answer the marked question. Your ? is still there.')
  }
  return { question: value.question.trim(), answer: value.answer.trim() }
}

/** Apply brevity even when a typed question or a later conversation turn asks for more. */
export function buildAskPrompt(question: unknown) {
  const typed = typeof question === 'string' ? question.trim().slice(0, 2000) : ''
  return `This is my current canvas screenshot.
${CANVAS_INPUT_RULES}
Answer the current handwritten message directly. Prioritize a question or unfinished equation over older greetings. For an idea or draft, give one concrete next step; for a greeting, reply naturally. If there is no clear task, ask one short question about what I want to do.
${typed ? `My question: ${typed}\n` : ''}${CANVAS_REPLY_RULES}`
}
