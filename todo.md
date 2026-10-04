# Standalone question canvas

### Feature

**You own the design. Plan, review, verify.** Delegate implementation. Stay in the lead.

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Delegate code-writing to a subagent using your configured feature model (default in poteto-mode's Models section) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria). When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the **arena** skill instead so the runners surface the alternatives and the cross-judge guards the pick. Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation. No "standing by" reply that waits on a nested agent. **Give every file-writing delegate its own worktree** (spawn it with `isolation: "worktree"`, or hand it an exclusive branch), and do not write files or run a suite in a worktree a delegate still holds. Fencing a file in the brief's prose is not a lock (**principle-separate-before-serializing-shared-state**). Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Rebase into small, ordered commits. Stack follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline. That owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries. Spawn a fresh owner rather than chaining interrupts.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.

## Throughput checkpoint

- Blocking first steps. Trace existing trigger, probe Pi Durable browser compatibility, locate credential without exposing it, then settle runtime boundaries.
- Independent workstreams. Read-only app and native exploration parallelize. One implementation owner handles the coupled frontend/native contracts in an isolated worktree.
- Shared mutable state. Everyday board stays intact. Browser and device verification use isolated boards. Key provisioning uses an ignored temporary file and device Keychain.
- Smallest safe decomposition. One coupled implementation owner prevents drift in native bridge and browser runtime. Root owns design, review, and validation after ownership transfers.

## Architecture

- [x] Ground
- [x] Sketch
- [x] Agree
- [x] Implement
- [ ] Scrap if evidence invalidates design

## Arena

- [x] Frame
- [x] Fan out
- [x] Cross-judge
- [x] Pick
- [x] Graft
- [x] Verify

## Final checkpoints

- [x] Main workspace full pnpm test passes 47 tests.
- [x] Native build/install and Keychain provisioning.
- [x] Native live image probe reads Standalone canvas through iPad networking.
- [x] Relaunch restores existing SDK document from native storage.
- [x] Credential absent from frontend and application bundle; transient device import deleted.
- [ ] Physical Pencil and question recognition quality.
  Unverified. Requires actual human Pencil input.
- [ ] Commit/rebase/open PR on main checkout.
  skip: Local prototype delivered; preserve user staged changes and no PR requested. Implementation commits remain on isolated branch.

## Pencil loop and white-screen repair

- [x] Ground. Trace local input, native model, and rendering lifecycle.
- [x] Reproduce. Palm blocks trigger; pending ink expires at 15 seconds. Regression tests fail before repair.
- [x] Sketch. Keep current SDK-owned stroke and pointer sets; filter non-Pencil activity in pen mode, retain bounded pending ink without age expiry.
- [x] Agree. Proceed under the user's request to repair and simplify.
- [x] Implement. Apply isolated input repair, native development-build correction, and real question verification.
- [x] Verify. Full browser suite passed 44 tests. Native live question returned 2 with exact Undo. Native canvas and controls remained visible beyond 95 seconds, with saved answer restored on relaunch.
- [ ] Physical Pencil check. Requires actual user input; synthetic events remain separately labeled.
- [x] Scrap. No redesign needed. Native evidence confirmed the SDK license gate removed the production-mode canvas after five seconds. Debug frontend configuration fixes the cause.

Throughput checkpoint. Native root-cause evidence gates the rendering fix. Input repair, verification extraction, and native build work use separate worktrees. Only root installs on the physical iPad and applies reviewed diffs to this dirty checkout. Existing staged work and everyday board content stay intact.

## Answer selection and quality repair

- [x] Inspect the actual iPad and preserve its native board and journals.
- [x] Trace wrong replies to retained image history, persisted stale instructions, and ambiguous coordinate-only targeting.
- [x] Compare live provider outputs on the actual captured questions. Fresh history alone still selected the wrong question; a red target box selected the intended life question.
- [x] Implement fresh answer context, explicit configuration, model-only target marking, and useful compact explanations.
- [x] Verify reopened conversations, current-image-only requests, target image pixels, exact undo, and sequential real native questions.
- [x] Correct the two bad existing answer shapes with a backed-up, revision-checked SDK document edit, preserving all handwriting.

Throughput checkpoint. Model evidence gates prompt and capture changes. Answer implementation and sequential device verification use isolated worktrees. Root alone installs on the device and edits its saved board. The original document is retained as an editable backup.

Final answer repair evidence. Full suite47/47 passed (1791119201039-a85676cd). Native live sequential questions passed (standalone-1791119201668), including nonoverlap and exact Undo/Redo. Original handwriting replay returned relevant monad and life explanations. Existing bad replies repaired with revision guards and SDK edits; new user strokes preserved. Added current UTC date to each native/LAN request; corrected stale age reply from official birth date. Human Pencil input occurred during the session but was not a controlled physical test.

## Quiet question collaboration

- [x] Ground. Trace trigger, asynchronous capture, native attempts, shape metadata, and undo from the current app.
- [x] Frame. Preserve automatic Pencil questions while making each request visible, stable, cancellable, and individually reversible.
- [x] Fan out. Compare a bounded request object with a shape-cohort design.
- [x] Cross-judge. Review cancellation, capture consistency, low-chrome UI, durable reversal, and complexity.
- [x] Pick and graft. Save the chosen interfaces before implementation.
- [x] Agree. Proceed under the user's agreement to the proposed next interaction.
- [x] Implement. One isolated owner for the coupled request lifecycle and contextual UI.
- [x] Verify. Final full suite passed 54/54 (1791121466634-61bf42c2); isolated native live answers and reload controls passed; everyday board preserved.
- [x] Scrap. Keep the request design; remove the arbitrary pending-queue cap after review exposed offscreen starvation.

Throughput checkpoint:
- Blocking first steps: source grounding and request-boundary design before implementation.
- Independent workstreams: read-only design candidates run independently; root owns review and device operation.
- Shared mutable state: implementation uses an isolated worktree; only root integrates and installs.
- Smallest safe decomposition: one implementation owner because trigger, context, metadata, and UI share one lifecycle contract.

Quiet question device evidence. Live native sequential questions and saved transcriptions passed (standalone-1791121419224). Reloaded answer controls passed exact restoration, preservation of later notes, no automatic retry, and one-step undo (standalone-1791121466186). A first live run repeated the prior monad answer for the life question despite structural checks passing; tighten question targeting and require matching saved transcription in the native verifier. Everyday board matched its pre-install backup exactly. Physical Pencil input remains unverified.
