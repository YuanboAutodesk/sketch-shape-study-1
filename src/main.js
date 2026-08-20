// The study: 20 objects drawn at random from the pool -- "sketch + two shapes -> which is
// better?" -- a different draw, in a different order, per participant.
//
// FOUR CHOICES PER PAIR, not one. Asking only "which do you prefer" hides why; asking per
// criterion lets a shape win on detail and lose on proportion, and the separate overall
// choice records how the participant weighs that themselves rather than us inferring it.
//
// WHAT THE RESULTS FILE HAS TO SURVIVE. The participant only ever sees "A" and "B"; the
// analysis needs to know which of those was ours. So every round records the four choices
// already resolved to 'ours'/'vlm', plus which side held which method and the exact shape
// ids -- nothing has to be inferred from the order of anything.
//
// RUNS WITHOUT A SERVER. Every asset path is relative WITHOUT a leading `/` or `../`, so the
// study works both at a domain root and under a subpath like /sketch-shape-study/ that
// GitHub project Pages serves from -- `../shapes/x` would climb out of that subpath and 404.
// The dev server maps /shapes to ../shapes so the same paths resolve there too. The POST to
// api/results is best-effort and the answers live in localStorage plus a download button, so
// dropping this folder next to a `shapes/` on any static host is a working study; the
// download at the end is then the ONLY way results come back.
//
// Sampling: side assignment is a fresh coin flip each round (so a participant cannot learn
// "ours is always left"), the example order is a shuffle rather than a cycle, and within an
// example the ours-shape and vlm-shape are drawn from that example's candidates, without
// repeating an (example, ours, vlm) triple inside one session.

import { ShapeViewer } from './viewer.js'

// A session is this many objects, drawn at random from the pool without repeats. Fewer than
// the pool holds, on purpose: it keeps a session to a sane length while still giving every
// object a chance to be seen by any given participant.
const DEFAULT_ROUNDS = 20
const SIDES = ['A', 'B']

// The four questions, in the order they are asked. `key` is what lands in the JSON.
// `overall` is asked last, after the participant has looked at the three parts of it.
const CRITERIA = [
  { key: 'details', label: 'Details', hint: 'which has more of the sketch\u2019s detail?' },
  { key: 'proportion', label: 'Proportion', hint: 'which has the sizes and placement right?' },
  { key: 'fidelity', label: 'Fidelity', hint: 'which depicts this object, buildably?' },
  { key: 'overall', label: 'Overall', hint: 'all things considered, the better result' },
]

const $ = (id) => document.getElementById(id)

/**
 * URL options, so a short test pass needs no code edit:
 *   ?rounds=N          how many objects to show (default 20, capped at the pool size)
 *   ?examples=first    take the examples in manifest order instead of shuffling, i.e.
 *                      "the first N objects" -- for checking the flow, not for real data
 *   ?test=1            shorthand for rounds=2&examples=first, for checking the flow
 *   ?reveal=1          label which shape is ours and which is the VLM's, above each viewer.
 *                      For checking the study yourself -- a participant who can see the
 *                      labels is not rating blind, so a session run this way is stamped
 *                      `labels_shown: true` and must not be pooled with real answers.
 */
const opts = () => {
  const q = new URLSearchParams(location.search)
  const test = q.get('test') === '1' || q.get('test') === 'true'
  const n = Number(q.get('rounds'))
  return {
    rounds: Number.isFinite(n) && n >= 1 && n <= 200 ? Math.floor(n) : (test ? 2 : DEFAULT_ROUNDS),
    order: q.get('examples') === 'first' || test ? 'first' : 'shuffle',
    reveal: q.get('reveal') === '1' || q.get('reveal') === 'true',
    test,
  }
}

/**
 * The examples that can be shown at all: a sketch, one of ours, and one of the VLM's.
 *
 * The sketch is checked by FETCHING it, not by trusting the manifest. `shapes/sketches/` is
 * curated by hand and a PNG deleted after the manifest was written leaves an entry behind --
 * three of them do right now -- and an example with no sketch has nothing to be judged
 * against, so it is dropped whether or not both shapes exist.
 */
async function loadPool(manifest) {
  const candidates = manifest.examples.filter((e) => e.ours?.length && e.vlm?.length && e.sketch)
  const present = await Promise.all(candidates.map(async (e) => {
    try {
      const r = await fetch(`shapes/${e.sketch}`, { method: 'HEAD' })
      if (r.ok) return true
      if (r.status !== 405 && r.status !== 501) return false
      return (await fetch(`shapes/${e.sketch}`)).ok      // host without HEAD support
    } catch (err) {
      return false
    }
  }))
  return candidates.filter((_, i) => present[i])
}

const state = {
  manifest: null,
  sinkDead: false,             // a static host has no result sink; stop posting after one 404
  reveal: false,               // ?reveal=1: shapes are labelled with the system that built them
  pool: [],                    // the examples that survive the sketch check
  trials: [],
  round: 0,
  session: null,
  viewers: {},
  roundStart: 0,
  busy: false,
  choice: {},                  // criterion -> 'A' | 'B', for the round on screen
  answers: [],                 // per round index: the choices made, so Back can restore them
  cursor: 0,                   // which question the A/B keys answer
}

// ---------------------------------------------------------------- sampling

function shuffled(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

/**
 * n trials. Examples are drawn in shuffled passes, so a session of n <= pool size is n
 * DISTINCT objects sampled at random -- no object can come up twice while another is missed,
 * and each participant gets a different draw. Within a trial the two shapes are sampled from
 * that example's candidates, and an (example, ours, vlm) triple is never repeated.
 */
function buildTrials(pool, n, order = 'shuffle') {
  const examples = pool

  // ?examples=first: the first n objects, in manifest order, one round each. A test pass is
  // meant to be repeatable and to show a known object, which a shuffle cannot promise.
  if (order === 'first') {
    return examples.slice(0, n).map((ex, i) => {
      const oursSide = Math.random() < 0.5 ? 'A' : 'B'
      return {
        round: i + 1,
        example: ex.example,
        object: ex.object,
        sketch: ex.sketch,
        ours_id: ex.ours[0].id,
        ours_path: ex.ours[0].path,
        vlm_id: ex.vlm[0].id,
        vlm_path: ex.vlm[0].path,
        ours_side: oursSide,
        vlm_side: oursSide === 'A' ? 'B' : 'A',
      }
    })
  }

  const seen = new Set()
  const trials = []
  let bag = []
  let starved = 0

  while (trials.length < n && starved < examples.length * 4) {
    if (!bag.length) bag = shuffled(examples)
    const ex = bag.pop()

    let ours = null, vlm = null, key = null
    for (let attempt = 0; attempt < 40; attempt++) {
      const o = pick(ex.ours), v = pick(ex.vlm)
      key = `${ex.example}|${o.id}|${v.id}`
      if (!seen.has(key)) { ours = o; vlm = v; break }
    }
    if (!ours) { starved += 1; continue }      // this example is exhausted; try another
    starved = 0
    seen.add(key)

    const oursSide = Math.random() < 0.5 ? 'A' : 'B'
    trials.push({
      round: trials.length + 1,
      example: ex.example,
      object: ex.object,
      sketch: ex.sketch,
      ours_id: ours.id,
      ours_path: ours.path,
      vlm_id: vlm.id,
      vlm_path: vlm.path,
      ours_side: oursSide,
      vlm_side: oursSide === 'A' ? 'B' : 'A',
    })
  }
  return trials
}

// ---------------------------------------------------------------- persistence

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
}

function newSession(participant, reveal) {
  // Deliberately bare: a username, when it ran, and the choices. The criteria wording and
  // everything else a legend used to carry lives in this repo, not in every session file.
  return {
    username: slug(participant.username) || 'anon',
    experience: participant.experience || null,
    // only present when the run was NOT blind, so a blind file stays as bare as before
    ...(reveal ? { labels_shown: true } : {}),
    started_at: new Date().toISOString(),
    finished_at: null,
    rounds: [],
  }
}

async function save(session, { final = false } = {}) {
  try {
    localStorage.setItem('user_choice_last_session', JSON.stringify(session))
  } catch (err) { /* private browsing / quota -- the download still works */ }
  // On a static host there is no sink at all. One failed POST is enough to know that, so the
  // rest of the session stops asking instead of throwing a 404 every round.
  if (state.sinkDead) return null
  try {
    const r = await fetch('api/results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session),
    })
    const j = await r.json()
    if (!j.ok) throw new Error(j.error || 'save refused')
    $('save-status').textContent = `saved ${j.saved}`
    return j.saved
  } catch (err) {
    state.sinkDead = true
    // the study must not stall because the sink is down -- and when this is hosted as a
    // static site there IS no sink, which is the normal case, not an error
    $('save-status').textContent = 'answers kept in this browser — download at the end'
    if (final) console.warn(err)
    return null
  }
}

function download(session) {
  const blob = new Blob([JSON.stringify(session, null, 1)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${session.username}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

// ---------------------------------------------------------------- the choice widget

/** Build the four "A or B" rows under the two viewers. Called once, at start-up. */
function buildChoiceUI() {
  const host = $('choices')
  host.innerHTML = ''
  for (const c of CRITERIA) {
    const row = document.createElement('div')
    row.className = 'choice-row'
    row.dataset.key = c.key
    if (c.key === 'overall') row.classList.add('overall')

    const label = document.createElement('div')
    label.className = 'choice-label'
    label.innerHTML = `<b>${c.label}</b><span>${c.hint}</span>`
    row.appendChild(label)

    const btns = document.createElement('div')
    btns.className = 'choice-btns'
    for (const side of SIDES) {
      const b = document.createElement('button')
      b.className = 'pick'
      b.type = 'button'
      b.textContent = side
      b.dataset.side = side
      b.title = `${c.label}: shape ${side} is better`
      b.addEventListener('click', () => setChoice(c.key, side))
      btns.appendChild(b)
    }
    row.appendChild(btns)
    host.appendChild(row)
  }
}

function setChoice(key, side) {
  if (state.busy) return
  state.choice[key] = side
  // the keyboard cursor follows the click, then walks on to the next unanswered row
  state.cursor = CRITERIA.findIndex((c) => c.key === key)
  advanceCursor()
  paintChoices()
}

/** Move the cursor to the next question with no answer yet (wrapping once). */
function advanceCursor() {
  for (let i = 1; i <= CRITERIA.length; i++) {
    const j = (state.cursor + i) % CRITERIA.length
    if (!state.choice[CRITERIA[j].key]) { state.cursor = j; return }
  }
  state.cursor = -1                                     // every question answered
}

function nAnswered() {
  return CRITERIA.filter((c) => state.choice[c.key]).length
}

function paintChoices() {
  for (const row of document.querySelectorAll('.choice-row')) {
    const key = row.dataset.key
    const picked = state.choice[key]
    row.classList.toggle('active', CRITERIA[state.cursor]?.key === key)
    row.classList.toggle('done', !!picked)
    for (const b of row.querySelectorAll('.pick')) {
      b.classList.toggle('on', b.dataset.side === picked)
    }
  }
  const n = nAnswered()
  $('rate-progress').textContent = `${n} / ${CRITERIA.length} chosen`
  // every question has to be answered: with two shapes there is no sensible "no answer"
  $('btn-next').disabled = state.busy || n < CRITERIA.length
  $('btn-back').disabled = state.busy || state.round === 0
}

// ---------------------------------------------------------------- trial flow

function showScreen(name) {
  for (const s of ['start', 'trial', 'done']) {
    $(`screen-${s}`).classList.toggle('hidden', s !== name)
  }
}

async function runRound() {
  const t = state.trials[state.round]
  const last = state.round === state.trials.length - 1
  $('round-label').textContent = `shape ${t.round} / ${state.trials.length}`
  $('progress-fill').style.width = `${(100 * state.round) / state.trials.length}%`
  $('sketch-img').src = `shapes/${t.sketch}`
  $('btn-next').textContent = last ? 'Finish' : 'Next shape'

  // ?reveal=1 only: say which system built which shape, above its viewer
  for (const side of SIDES) {
    const tag = $(`tag-${side}`)
    tag.classList.toggle('hidden', !state.reveal)
    if (!state.reveal) continue
    const ours = t.ours_side === side
    tag.textContent = ours ? `ours · ${t.ours_id}` : `VLM · ${t.vlm_id}`
    tag.classList.toggle('is-ours', ours)
  }

  // a revisited round comes back with its own answers on screen, not blank
  const held = state.answers[state.round]
  state.choice = held ? { ...held.choice } : {}
  state.cursor = CRITERIA.findIndex((c) => !state.choice[c.key])
  state.busy = true
  paintChoices()

  const forSide = (side) => (t.ours_side === side ? t.ours_path : t.vlm_path)
  await Promise.all([
    state.viewers.A.load(`shapes/${forSide('A')}`),
    state.viewers.B.load(`shapes/${forSide('B')}`),
  ])
  state.busy = false
  paintChoices()
  state.roundStart = performance.now()
}

/** Freeze what is on screen into the answer list. Called before every navigation. */
function commitCurrent() {
  const held = state.answers[state.round]
  const spent = (performance.now() - state.roundStart) / 1000
  state.answers[state.round] = {
    choice: { ...state.choice },
    // a revisited round is timed over all its visits, not just the last one
    seconds: +((held?.seconds || 0) + spent).toFixed(2),
  }
}

/**
 * The answers so far, in the form the results file takes. Built fresh on every navigation
 * rather than appended to, so going back and changing a score REPLACES that round instead of
 * adding a second copy of it.
 */
function roundsForFile() {
  return state.answers.map((a, i) => {
    if (!a) return null
    const t = state.trials[i]
    // resolved to the system that built the shape, so reading the file needs no key; the
    // side each shape was on is kept because it is the study's only randomisation
    const chose = {}
    for (const c of CRITERIA) {
      const side = a.choice[c.key]
      chose[c.key] = side ? (side === t.ours_side ? 'ours' : 'vlm') : null
    }
    return {
      round: t.round,
      example: t.example,
      object: t.object,
      ours: { id: t.ours_id, side: t.ours_side },
      vlm: { id: t.vlm_id, side: t.vlm_side },
      chose,
      seconds: a.seconds,
    }
  }).filter(Boolean)
}

async function goNext() {
  if (state.busy || nAnswered() < CRITERIA.length) return
  commitCurrent()
  const isLast = state.round === state.trials.length - 1
  state.session.rounds = roundsForFile()
  state.session.finished_at = isLast ? new Date().toISOString() : null

  state.busy = true
  paintChoices()
  const saved = await save(state.session, { final: isLast })
  state.busy = false

  if (!isLast) {
    state.round += 1
    return runRound()
  }
  finish(saved)
}

async function goBack() {
  if (state.busy || state.round === 0) return
  commitCurrent()
  state.session.rounds = roundsForFile()
  state.round -= 1
  await runRound()
  save(state.session)
}

/** From the finish screen back into the last round, to change an answer. */
async function reopenLastRound() {
  state.round = state.trials.length - 1
  state.session.finished_at = null
  showScreen('trial')
  await runRound()
}

function finish(saved) {
  // Deliberately says nothing about the scores. A participant who is shown their own
  // averages at the end has been told how they came across, which is feedback they cannot
  // act on and which would colour a second session; the file is the only thing that matters
  // here, so the screen is a thank-you and a download button.
  $('done-path').textContent = saved
    ? `Also written on the study machine to ${saved}.`
    : 'Nothing was written to a server — the downloaded file is the only copy, please send it back.'
  showScreen('done')
}

// ---------------------------------------------------------------- wiring

function readParticipant() {
  const username = $('in-username').value.trim()
  if (slug(username).length < 2) {
    $('in-username').focus()
    $('start-status').textContent =
      'please choose a username (at least 2 letters or digits) to continue'
    return null
  }
  return {
    username,
    experience: $('in-experience').value || null,
  }
}

async function begin() {
  const participant = readParticipant()
  if (!participant) return

  const o = opts()
  state.trials = buildTrials(state.pool, Math.min(o.rounds, state.pool.length), o.order)
  if (!state.trials.length) {
    $('start-status').textContent = 'no examples with both a sketch and both shapes — run prepare_shapes.py'
    return
  }
  state.session = newSession(participant, o.reveal)
  state.reveal = o.reveal
  $('reveal-note').classList.toggle('hidden', !o.reveal)
  state.answers = []
  state.round = 0
  showScreen('trial')

  state.viewers.A?.dispose()
  state.viewers.B?.dispose()
  state.viewers.A = new ShapeViewer($('viewer-a'))
  state.viewers.B = new ShapeViewer($('viewer-b'))

  // Independent cameras, on purpose: dragging one shape must never move the other, so a
  // participant can turn each to whatever angle shows it best before judging.

  requestAnimationFrame(() => {
    state.viewers.A.resize()
    state.viewers.B.resize()
  })
  await runRound()
}

async function init() {
  buildChoiceUI()

  try {
    state.manifest = await (await fetch('shapes/manifest.json')).json()
    state.pool = await loadPool(state.manifest)
  } catch (err) {
    $('start-status').textContent = 'could not load shapes/manifest.json — run prepare_shapes.py'
    return
  }
  const n = state.pool.length
  if (!n) {
    $('start-status').textContent = 'no example has a sketch in shapes/sketches/ — nothing to show'
    return
  }
  $('round-count').textContent = String(Math.min(opts().rounds, n))
  $('pool-count').textContent = String(n)
  $('start-status').textContent = `${n} objects loaded.`
  $('btn-begin').disabled = false

  $('btn-begin').addEventListener('click', begin)
  $('in-username').addEventListener('input', () => {
    const name = slug($('in-username').value) || '<username>'
    $('username-hint').innerHTML = `your results arrive as <code>${name}.json</code>`
  })
  $('btn-next').addEventListener('click', goNext)
  $('btn-back').addEventListener('click', goBack)
  $('btn-back-done').addEventListener('click', reopenLastRound)
  $('btn-reset-view').addEventListener('click', () => {
    state.viewers.A?.resetView()
    state.viewers.B?.resetView()
  })
  $('btn-download').addEventListener('click', () => download(state.session))
  $('btn-restart').addEventListener('click', () => {
    $('start-status').textContent = 'ready'
    showScreen('start')
  })

  addEventListener('keydown', (e) => {
    if ($('screen-trial').classList.contains('hidden')) return
    if (e.key === 'Enter') { e.preventDefault(); return goNext() }
    if (e.key === 'ArrowLeft') { e.preventDefault(); return goBack() }
    const k = e.key.toLowerCase()
    if (k !== 'a' && k !== 'b') return
    if (state.cursor < 0 || state.busy) return
    setChoice(CRITERIA[state.cursor].key, k.toUpperCase())
  })
}

init()
