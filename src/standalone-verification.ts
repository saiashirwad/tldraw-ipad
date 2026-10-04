import { createShapeId, toRichText, type Editor, type TLPointerEventInfo } from 'tldraw'
import { captureLocalView } from './local-board'
import { readNativeFile, writeNativeFile } from './native'
import { QUESTION_IDLE_MS } from './question-mark'

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export async function runStandaloneVerification({ editor, flushBoard, buildId }: {
  editor: Editor; flushBoard(): Promise<void>; buildId: string
}) {
  const params = new URLSearchParams(location.search)
  const scenario = params.get('nativeVerify')
  if (!scenario) return
  const identity = { runID: params.get('nativeVerifyRun'), buildId, origin: location.href }
  const replies: { question: string; transcription: string; reply: string; markerIds: string[] }[] = []
  try {
    if (!['render', 'stability', 'question', 'questions', 'live', 'answer-controls'].includes(scenario)) throw new Error(`Unknown verification scenario ${scenario}`)
    const loadedShapeIds = [...editor.getCurrentPageShapeIds()]
    const question = scenario === 'question' || scenario === 'questions' || scenario === 'live'
    if (question && editor.getCurrentPageShapes().some((shape) => shape.meta.agentAnswer || shape.type === 'draw')) {
      throw new Error('Use a fresh isolated board for the question check')
    }
    const labelId = createShapeId('standalone-verification')
    if (!question && scenario !== 'answer-controls' && !editor.getShape(labelId)) editor.createShapes([{ id: labelId, type: 'text', x: 140, y: 220,
      props: { richText: toRichText('Standalone canvas'), size: 'l' } }])
    await editor.fonts.loadRequiredFontsForCurrentPage()
    let providerReply = ''
    let markerIds: string[] = []
    if (question) {
      editor.setCamera({ x: 0, y: 0, z: 1 })
      editor.setCurrentTool('draw')
      editor.updateInstanceState({ isPenMode: true, isToolLocked: true })
      await frame(); await frame()
      const stroke = async (points: number[][]) => {
        for (const [index, [x, y]] of points.entries()) {
          const event: TLPointerEventInfo = { type: 'pointer', target: 'canvas',
            name: index === 0 ? 'pointer_down' : index === points.length - 1 ? 'pointer_up' : 'pointer_move',
            point: { ...editor.pageToScreen({ x, y }), z: .5 }, pointerId: 73, button: 0, isPen: true, isPenDirect: true,
            shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false }
          editor.dispatch(event)
          await frame()
        }
      }
      const questions = scenario === 'questions' ? ['1 + 1 =', 'What is a monad?', 'What is the meaning of life?'] : ['1 + 1 =']
      for (const [index, text] of questions.entries()) {
        const y = 100 + index * 220
        const x = Math.min(620, editor.getViewportPageBounds().w - 120)
        const previousAnswers = editor.getCurrentPageShapes().filter((shape) => shape.meta.agentAnswer).map((shape) => shape.id)
        editor.createShapes([{ id: index === 0 ? labelId : createShapeId(), type: 'text', x: 80, y,
          props: { richText: toRichText(text), size: 'm', autoSize: false, w: x - 110 } }])
        await editor.fonts.loadRequiredFontsForCurrentPage()
        await stroke([[0, 15], [15, 0], [35, 2], [49, 16], [49, 34], [38, 47], [25, 58], [25, 73], [25, 73]].map(([dx, dy]) => [x + dx, y + dy]))
        await stroke([[25, 90], [26, 91], [26, 91]].map(([dx, dy]) => [x + dx, y + dy]))
        const original = editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw').sort((a, b) => a.id.localeCompare(b.id))
        if (original.length !== 2) throw new Error(`Expected hook and dot ink, got ${original.length} strokes`)
        markerIds = original.map((shape) => shape.id)
        const fingerprint = JSON.stringify(original)
        const newAnswers = () => editor.getCurrentPageShapes().filter((shape) => shape.meta.agentAnswer && !previousAnswers.includes(shape.id))
        const deadline = Date.now() + 120000
        while (!newAnswers().length) {
          const failure = document.querySelector('.ask-status')?.textContent
          if (failure) throw new Error(failure)
          if (Date.now() >= deadline) throw new Error(`Pen release did not answer ${JSON.stringify(text)} within 120 seconds`)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const answers = newAnswers()
        providerReply = answers.map((shape) => editor.getShapeUtil(shape).getText(shape)).join('').trim()
        const transcription = String(answers[0]?.meta.questionTranscription ?? '')
        replies.push({ question: text, transcription, reply: providerReply, markerIds })
        if (index === 1 && (!/monad/i.test(transcription) || !/monad/i.test(providerReply)) ||
          index === 2 && (!/meaning.*life/i.test(transcription) || /monad/i.test(providerReply))) {
          throw new Error(`The answer targeted a different question: ${JSON.stringify({ expected: text, transcription, providerReply })}`)
        }
        const normalized = providerReply.toLowerCase().replace(/[.!]/g, '').trim()
        if (answers.length !== 1 || (index === 0 ? providerReply !== '2' : normalized === '2' || normalized === 'not defined' || providerReply.length < 15)) {
          throw new Error(`Wrong answer to ${JSON.stringify(text)}: ${JSON.stringify(providerReply)}`)
        }
        const answerBounds = editor.getShapePageBounds(answers[0].id)!
        if (editor.getCurrentPageShapes().some((shape) => shape.id !== answers[0].id &&
          (shape.type === 'draw' || shape.type === 'text') && answerBounds.collides(editor.getShapePageBounds(shape.id)!))) {
          throw new Error('The new answer overlaps existing writing')
        }
        if (markerIds.some((id) => editor.getCurrentPageShapes().some((shape) => shape.id === id))) throw new Error('Answer did not replace the marker ink')
        await flushBoard()
        editor.undo()
        const restored = editor.getCurrentPageShapes().filter((shape) => shape.type === 'draw').sort((a, b) => a.id.localeCompare(b.id))
        if (JSON.stringify(restored) !== fingerprint || newAnswers().length || previousAnswers.some((id) => !editor.getShape(id))) {
          throw new Error('One undo did not restore the exact marker and remove only its answer')
        }
        editor.redo()
        if (!editor.getShape(answers[0].id) || markerIds.some((id) => editor.getCurrentPageShapes().some((shape) => shape.id === id))) {
          throw new Error('Redo did not restore the answer')
        }
      }
    }
    if (scenario === 'questions') {
      editor.createShapes([{ id: createShapeId('standalone-later-note'), type: 'text', x: 80, y: 780,
        props: { richText: toRichText('A later note stays here after restoring an earlier question mark.'), size: 'm', autoSize: false, w: 420 } }])
      editor.zoomToFit()
    }
    const answerControls = scenario === 'answer-controls' ? await verifyAnswerControls(editor, flushBoard) : undefined
    await flushBoard()
    const capture = await captureLocalView(editor)
    await writeNativeFile('verification-report.json', JSON.stringify({ ...identity, status: 'passed', loadedShapeIds,
      shapeIds: [...editor.getCurrentPageShapeIds()], provider: question ? 'passed' : 'unperformed', providerReply, replies, answerControls,
      input: question ? 'synthetic-sdk-pen' : 'none', physicalInput: 'unverified', markerIds,
      exactUndo: question ? 'passed' : 'unperformed', capture: capture.url.startsWith('data:image/png'), macRuntime: false }))
  } catch (error) {
    await writeNativeFile('verification-report.json', JSON.stringify({ ...identity, status: 'failed', error: String(error), replies, physicalInput: 'unverified' }))
  }
}

async function verifyAnswerControls(editor: Editor, flushBoard: () => Promise<void>) {
  const answers = editor.getCurrentPageShapes().filter((shape) => shape.meta.agentAnswer)
  const [answer, otherAnswer] = answers
  if (!answer || !otherAnswer || !editor.getShape(createShapeId('standalone-later-note'))) {
    throw new Error('Answer controls require a saved questions board with multiple answers and its later note')
  }
  const ink = answer.meta.questionMarkInk
  if (!Array.isArray(ink) || !ink.length) throw new Error('The reloaded answer has no original marker records')
  const markerIds = ink.map((record) => {
    if (!record || typeof record !== 'object' || !('id' in record) || typeof record.id !== 'string' || !record.id.startsWith('shape:')) {
      throw new Error('The reloaded answer has invalid marker records')
    }
    return createShapeId(record.id.slice(6))
  })
  if (markerIds.some((id) => editor.getShape(id))) throw new Error('Original marker IDs are already occupied before restoration')
  const records = () => editor.store.allRecords().filter((record) => record.typeName === 'shape').sort((a, b) => a.id.localeCompare(b.id))
  const baseline = JSON.stringify(records())
  const others = JSON.stringify(records().filter((shape) => shape.id !== answer.id))
  const attemptBefore = await readNativeFile('attempt.json')
  editor.select(answer.id)
  const button = await answerRestoreButton()
  const transcription = answer.meta.questionTranscription
  if (typeof transcription !== 'string' || !transcription.trim()) throw new Error('The saved answer lost its question transcription')
  const displayed = document.querySelector('.question-transcription')?.textContent
  if (!displayed?.includes('Read as') || !displayed.includes(transcription)) {
    throw new Error('The answer inspector did not display its saved question transcription after reload')
  }
  button.click()
  await frame(); await frame()
  if (editor.getShape(answer.id)) throw new Error('Restore question mark did not remove the selected answer')
  for (const [index, id] of markerIds.entries()) {
    if (JSON.stringify(editor.getShape(id)) !== JSON.stringify(ink[index])) throw new Error('Restore question mark changed the original marker record')
  }
  const otherRecords = () => records().filter((shape) => !markerIds.includes(shape.id))
  if (JSON.stringify(otherRecords()) !== others) throw new Error('Restoring an answer changed later notes or other shapes')
  await new Promise((resolve) => setTimeout(resolve, QUESTION_IDLE_MS + 500))
  if (await readNativeFile('attempt.json') !== attemptBefore || editor.getShape(answer.id) || JSON.stringify(otherRecords()) !== others ||
    markerIds.some((id, index) => JSON.stringify(editor.getShape(id)) !== JSON.stringify(ink[index]))) {
    throw new Error('Restoring a marker triggered another question or changed the saved writing')
  }
  editor.undo()
  if (JSON.stringify(records()) !== baseline) throw new Error('One undo did not reverse only the selected answer restoration')
  await flushBoard()
  editor.select(otherAnswer.id)
  await answerRestoreButton()
  return { reload: 'passed', transcription: 'passed', restoration: 'passed', otherInkPreserved: 'passed', noAutomaticRetry: 'passed',
    exactUndo: 'passed', restoredAnswerId: answer.id, markerIds, inspectorAnswerId: otherAnswer.id }
}

async function answerRestoreButton() {
  const deadline = Date.now() + 5000
  for (;;) {
    const button = document.querySelector('button[aria-label="Restore question mark"]')
    if (button instanceof HTMLButtonElement && !button.disabled) return button
    if (Date.now() >= deadline) throw new Error('Selecting an answer did not show its Restore question mark control')
    await frame()
  }
}
