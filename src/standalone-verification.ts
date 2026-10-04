import { createShapeId, toRichText, type Editor, type TLPointerEventInfo } from 'tldraw'
import { captureLocalView } from './local-board'
import { writeNativeFile } from './native'

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export async function runStandaloneVerification({ editor, flushBoard, buildId }: {
  editor: Editor; flushBoard(): Promise<void>; buildId: string
}) {
  const params = new URLSearchParams(location.search)
  const scenario = params.get('nativeVerify')
  if (!scenario) return
  const identity = { runID: params.get('nativeVerifyRun'), buildId, origin: location.href }
  const replies: { question: string; reply: string; markerIds: string[] }[] = []
  try {
    if (!['render', 'stability', 'question', 'questions', 'live'].includes(scenario)) throw new Error(`Unknown verification scenario ${scenario}`)
    const loadedShapeIds = [...editor.getCurrentPageShapeIds()]
    const question = scenario === 'question' || scenario === 'questions' || scenario === 'live'
    if (question && editor.getCurrentPageShapes().some((shape) => shape.meta.agentAnswer || shape.type === 'draw')) {
      throw new Error('Use a fresh isolated board for the question check')
    }
    const labelId = createShapeId('standalone-verification')
    if (!question && !editor.getShape(labelId)) editor.createShapes([{ id: labelId, type: 'text', x: 140, y: 220,
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
        replies.push({ question: text, reply: providerReply, markerIds })
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
    if (scenario === 'questions') editor.zoomToFit()
    await flushBoard()
    const capture = await captureLocalView(editor)
    await writeNativeFile('verification-report.json', JSON.stringify({ ...identity, status: 'passed', loadedShapeIds,
      shapeIds: [...editor.getCurrentPageShapeIds()], provider: question ? 'passed' : 'unperformed', providerReply, replies,
      input: question ? 'synthetic-sdk-pen' : 'none', physicalInput: 'unverified', markerIds,
      exactUndo: question ? 'passed' : 'unperformed', capture: capture.url.startsWith('data:image/png'), macRuntime: false }))
  } catch (error) {
    await writeNativeFile('verification-report.json', JSON.stringify({ ...identity, status: 'failed', error: String(error), replies, physicalInput: 'unverified' }))
  }
}
