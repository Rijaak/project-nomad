import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RosettaError,
  RosettaJaneClient,
  describeScore,
  describeSwarm,
  isTrainingActive,
  layerRanges,
  normalizeAdapterJob,
  normalizeScore,
  normalizeStatus,
  normalizeTraining,
  parseTrainingPairs,
  runNameFrom,
  trainingPercent,
  trialItems,
} from '../../app/utils/rosetta_jane.js'

/** A gateway status body as the Python side sends it. */
function raw(overrides: Record<string, unknown> = {}) {
  return {
    rosetta_jane: '0.1.0',
    model: 'rosetta',
    fingerprint: 'abcd',
    layers: 24,
    own_layers: 2,
    peers_known: 5,
    peers_serving: 4,
    layers_missing: [],
    thinnest_cover: 2,
    can_answer: true,
    peers_blocked: 0,
    checks: {
      compare_peers: 'auto',
      recheck_here: false,
      known_answers: true,
      require_checked: false,
    },
    last_answer: null,
    controls: true,
    service: { on: true, layers: [8, 16], training: false, steps_helped: 3, examples_helped: 0 },
    training: null,
    adapters: ['first-run'],
    ...overrides,
  }
}

test('a gateway status is read into a typed record', () => {
  const status = normalizeStatus(raw())!
  assert.equal(status.version, '0.1.0')
  assert.equal(status.ownLayers, 2)
  assert.equal(status.canAnswer, true)
  assert.deepEqual(status.service, {
    on: true,
    layers: [8, 16],
    training: false,
    stepsHelped: 3,
    examplesHelped: 0,
  })
  assert.deepEqual(status.adapters, ['first-run'])
  assert.equal(status.checks.comparePeers, 'auto')
  assert.equal(status.checks.knownAnswers, true)
})

test('anything that is not a Rosetta-Jane status is rejected rather than half-read', () => {
  assert.equal(normalizeStatus(null), null)
  assert.equal(normalizeStatus('ok'), null)
  // A plain Ollama server answers JSON too, just not this JSON.
  assert.equal(normalizeStatus({ models: [] }), null)
  assert.equal(normalizeStatus({ rosetta_jane: '0.1.0' }), null)
})

test('untrusted fields are coerced, never passed through', () => {
  const status = normalizeStatus(
    raw({
      peers_serving: 'many',
      can_answer: 'yes',
      layers_missing: [3, 'four', 5],
      adapters: ['ok', 7, { name: 'x' }],
      checks: 'none',
      service: 'on',
      training: { state: 'exploding' },
    })
  )!
  assert.equal(status.peersServing, 0)
  assert.equal(status.canAnswer, false)
  assert.deepEqual(status.layersMissing, [3, 5])
  assert.deepEqual(status.adapters, ['ok'])
  assert.equal(status.checks.knownAnswers, false)
  assert.equal(status.service, null)
  assert.equal(status.training, null)
})

test('layer ranges read the way a person would say them', () => {
  assert.equal(layerRanges([8, 9, 10, 14]), '8-10, 14')
  assert.equal(layerRanges([5]), '5')
  assert.equal(layerRanges([3, 2, 2, 1]), '1-3')
  assert.equal(layerRanges([]), '')
})

test('a swarm that cannot answer says which layers are missing', () => {
  const health = describeSwarm(
    normalizeStatus(raw({ can_answer: false, layers_missing: [10, 11, 12] }))!
  )
  assert.equal(health.level, 'error')
  assert.match(health.detail, /layers 10-12 of 24/)
})

test('no serving peers at all points at the group code, not at layers', () => {
  const health = describeSwarm(
    normalizeStatus(raw({ can_answer: false, peers_serving: 0, layers_missing: [2, 3] }))!
  )
  assert.equal(health.level, 'error')
  assert.match(health.detail, /group code/)
})

test('an unchecked swarm is a warning, not a clean bill of health', () => {
  const health = describeSwarm(
    normalizeStatus(
      raw({
        peers_serving: 1,
        thinnest_cover: 1,
        checks: {
          compare_peers: 'auto',
          recheck_here: false,
          known_answers: false,
          require_checked: false,
        },
      })
    )!
  )
  assert.equal(health.level, 'warning')
  assert.match(health.headline, /not being checked/)
})

test('auto comparison only counts once three serving peers are present', () => {
  const two = describeSwarm(normalizeStatus(raw({ peers_serving: 2, thinnest_cover: 2 }))!)
  assert.equal(two.level, 'ok')
  assert.match(two.detail, /known-answer tests/)
  const four = describeSwarm(normalizeStatus(raw({ peers_serving: 4, thinnest_cover: 2 }))!)
  assert.match(four.detail, /compared between peers/)
})

test('comparison switched off by hand is reported as off even with many serving peers', () => {
  const health = describeSwarm(
    normalizeStatus(
      raw({
        checks: {
          compare_peers: 1,
          recheck_here: false,
          known_answers: false,
          require_checked: false,
        },
      })
    )!
  )
  assert.equal(health.level, 'warning')
})

test('training progress is a bounded percentage', () => {
  const job = normalizeTraining({ state: 'running', name: 'a', step: 5, total_steps: 20 })!
  assert.equal(trainingPercent(job), 25)
  assert.equal(trainingPercent({ ...job, step: 99 }), 100)
  assert.equal(trainingPercent({ ...job, totalSteps: 0 }), 0)
  assert.equal(isTrainingActive(job), true)
  assert.equal(isTrainingActive({ ...job, state: 'done' }), false)
  assert.equal(isTrainingActive(null), false)
})

test('pairs are read from JSON Lines, with bad lines reported', () => {
  const { pairs, problems } = parseTrainingPairs(
    [
      '{"question": "What is NOMAD?", "answer": "An offline box."}',
      '',
      'not json',
      '{"question": "No answer here"}',
      '{"prompt": " Alt names ", "response": " also work "}',
    ].join('\n')
  )
  assert.deepEqual(pairs, [
    { question: 'What is NOMAD?', answer: 'An offline box.' },
    { question: 'Alt names', answer: 'also work' },
  ])
  assert.deepEqual(problems, ['Line 3 is not valid JSON', 'Line 4 has no answer'])
})

test('pairs are read from a JSON list too', () => {
  const { pairs, problems } = parseTrainingPairs('﻿[{"question":"a","answer":"b"}, 7]')
  assert.deepEqual(pairs, [{ question: 'a', answer: 'b' }])
  assert.deepEqual(problems, ['Item 2 is not an object'])
})

test('an empty or broken file yields no pairs and says why', () => {
  assert.deepEqual(parseTrainingPairs('   '), { pairs: [], problems: ['The file is empty.'] })
  const broken = parseTrainingPairs('[{"question": ')
  assert.equal(broken.pairs.length, 0)
  assert.match(broken.problems[0], /not valid JSON/)
})

test('only a handful of problems are reported for a file full of them', () => {
  const { problems } = parseTrainingPairs(Array(50).fill('nope').join('\n'))
  assert.equal(problems.length, 5)
})

test('run names are made safe for the gateway', () => {
  assert.equal(runNameFrom('My First Run!'), 'my-first-run')
  assert.equal(runNameFrom('../../etc/passwd'), 'etc-passwd')
  assert.equal(runNameFrom('   '), 'run')
  assert.equal(runNameFrom('x'.repeat(80)).length, 40)
  assert.match(runNameFrom('a'.repeat(39) + '--b'), /^[a-z0-9][a-z0-9-]{0,39}$/)
})

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return { impl, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('the client sends the token and reads the status', async () => {
  const { impl, calls } = fakeFetch(() => json(raw()))
  const status = await new RosettaJaneClient('http://jane:11435/', 'secret', impl).status()
  assert.equal(status.model, 'rosetta')
  assert.equal(calls[0].url, 'http://jane:11435/api/rosetta/status')
  assert.equal((calls[0].init.headers as any).Authorization, 'Bearer secret')
})

test('an address that is not a gateway is named as such', async () => {
  const { impl } = fakeFetch(() => json({ models: [] }))
  await assert.rejects(
    new RosettaJaneClient('http://ollama:11434', null, impl).status(),
    /not a Rosetta-Jane gateway/
  )
})

test('gateway refusals become messages a person can act on', async () => {
  const wrong = fakeFetch(() => json({ error: 'wrong or missing control token' }, 401))
  await assert.rejects(
    new RosettaJaneClient('http://j', 'x', wrong.impl).setService({ on: false }),
    /token is wrong/
  )
  const off = fakeFetch(() => json({ error: 'controls are switched off' }, 403))
  await assert.rejects(
    new RosettaJaneClient('http://j', 'x', off.impl).stopTraining(),
    /--controls/
  )
  const busy = fakeFetch(() =>
    json({ error: 'a training run is already going; stop it first' }, 400)
  )
  await assert.rejects(
    new RosettaJaneClient('http://j', 'x', busy.impl).startTraining({
      pairs: [],
      name: 'a',
      epochs: 1,
    }),
    (error: unknown) =>
      error instanceof RosettaError && /already going/.test(error.message) && error.status === 400
  )
})

test('an unreachable gateway is reported without leaking a stack of network errors', async () => {
  const { impl } = fakeFetch(() => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(
    new RosettaJaneClient('http://gone:1', null, impl).status(),
    /Could not reach Rosetta-Jane at http:\/\/gone:1/
  )
})

test('an adapter download passes the bytes through untouched', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 9])
  const { impl, calls } = fakeFetch(() => new Response(bytes, { status: 200 }))
  const out = await new RosettaJaneClient('http://j', 'tok', impl).downloadAdapter('first-run')
  assert.deepEqual(new Uint8Array(out), bytes)
  assert.equal(calls[0].url, 'http://j/api/rosetta/adapters/first-run')
  const missing = fakeFetch(() => json({ error: 'no' }, 404))
  await assert.rejects(
    new RosettaJaneClient('http://j', 'tok', missing.impl).downloadAdapter('gone'),
    /no longer on the gateway/
  )
})

test('a score card is read, bounded and described in plain words', () => {
  const job = normalizeTraining({
    state: 'scoring',
    name: 'a',
    step: 4,
    total_steps: 4,
    pairs_kept_back: 2,
    score: {
      pairs: 2,
      never_trained_on: true,
      before: { loss: 2.5, right_next_word: 0.25 },
      after: { loss: 1.9, right_next_word: 0.5 },
      verdict: 'better with the adapter (on only 2 pairs; too few to rely on)',
      work_unchecked: 3,
    },
  })!
  assert.equal(job.state, 'scoring')
  assert.equal(isTrainingActive(job), true)
  assert.equal(job.pairsKeptBack, 2)
  assert.equal(job.score!.rightAfter, 0.5)
  const line = describeScore(job.score!)
  assert.match(line, /Scored on 2 pairs kept back from training/)
  assert.match(line, /25\.0% of answer words right without the adapter, 50\.0% with it/)
  assert.match(line, /too few to rely on/)
})

test('a score that is not made of real numbers is dropped, not shown', () => {
  assert.equal(normalizeScore(null), null)
  assert.equal(normalizeScore({ before: { loss: 'low' }, after: {} }), null)
  assert.equal(
    normalizeScore({
      before: { loss: 1, right_next_word: 0.1 },
      after: { loss: Number.NaN, right_next_word: 0.2 },
    }),
    null
  )
  const odd = normalizeScore({
    pairs: 3,
    before: { loss: 1, right_next_word: -4 },
    after: { loss: 1, right_next_word: 9 },
  })!
  assert.equal(odd.rightBefore, 0)
  assert.equal(odd.rightAfter, 1)
  assert.equal(odd.neverTrainedOn, false)
})

test('a list of questions starts each one fresh; a chat carries each side forward separately', () => {
  assert.deepEqual(trialItems([' What is NOMAD? ', '', 'And maps?']), [
    {
      without: [{ role: 'user', content: 'What is NOMAD?' }],
      with: [{ role: 'user', content: 'What is NOMAD?' }],
    },
    {
      without: [{ role: 'user', content: 'And maps?' }],
      with: [{ role: 'user', content: 'And maps?' }],
    },
  ])
  const [turn] = trialItems(
    ['Go on'],
    [{ question: 'Hi', without: 'Plain reply', with: 'Tuned reply' }]
  )
  assert.deepEqual(turn.without, [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Plain reply' },
    { role: 'user', content: 'Go on' },
  ])
  // The adapter's side remembers what the adapter said, not what the plain model said.
  assert.equal(turn.with[1].content, 'Tuned reply')
  assert.equal(trialItems(Array(80).fill('q')).length, 50)
  // An empty earlier reply still has to be a message, or the two sides would fall out of step.
  assert.equal(
    trialItems(['x'], [{ question: 'a', without: '', with: 'b' }])[0].without[1].content,
    '(no reply)'
  )
})

test('a trial or scoring in progress is read without trusting its shape', () => {
  const job = normalizeAdapterJob({
    kind: 'try',
    name: 'friends-model',
    state: 'running',
    done: 1,
    total: 2,
    result: { answers: [{ without: 'a', with: 'b' }, { without: 7 }, 'junk'] },
  })!
  assert.equal(job.answers.length, 1)
  assert.deepEqual(job.answers[0], { without: 'a', with: 'b' })
  assert.equal(normalizeAdapterJob({ kind: 'apply', state: 'done' }), null)
  assert.equal(normalizeAdapterJob({ kind: 'try', state: 'exploding' }), null)
  const scored = normalizeAdapterJob({
    kind: 'score',
    name: 'x',
    state: 'done',
    result: { lines: ['Scored on 8 pairs', 9], share_text: 'Rosetta-Jane score card: x' },
  })!
  assert.deepEqual(scored.lines, ['Scored on 8 pairs'])
  assert.equal(scored.shareText, 'Rosetta-Jane score card: x')
  const status = normalizeStatus(
    raw({
      adapter_details: [{ name: 'x', received: true, my_score: true }, { nope: 1 }],
      adapter_job: null,
    })
  )!
  assert.deepEqual(status.adapterDetails, [
    { name: 'x', received: true, scored: false, myScore: true },
  ])
  assert.equal(status.adapterJob, null)
})

test('the Model Adapter Score document is fetched with the token and bounded', async () => {
  const page = '<!doctype html><title>Model Adapter Score</title>'
  const { impl, calls } = fakeFetch(() => new Response(page, { status: 200 }))
  const out = await new RosettaJaneClient('http://j', 'tok', impl).scoreDocument()
  assert.equal(out, page)
  assert.equal(calls[0].url, 'http://j/api/rosetta/model-adapter-score')
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer tok')
  const refused = fakeFetch(() => json({ error: 'no' }, 401))
  await assert.rejects(
    new RosettaJaneClient('http://j', 'bad', refused.impl).scoreDocument(),
    /check the control token/
  )
  const old = fakeFetch(() => json({ error: 'no' }, 404))
  await assert.rejects(
    new RosettaJaneClient('http://j', 'tok', old.impl).scoreDocument(),
    /too old/
  )
  const huge = fakeFetch(() => new Response('x'.repeat(8 * 1024 * 1024 + 1), { status: 200 }))
  await assert.rejects(
    new RosettaJaneClient('http://j', 'tok', huge.impl).scoreDocument(),
    /too large/
  )
})
