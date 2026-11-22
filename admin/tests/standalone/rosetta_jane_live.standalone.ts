// Drives a running Rosetta-Jane gateway with NOMAD's own client, the same calls
// the settings page makes. Not part of the unit run: it needs a live gateway.
//   node --import ts-node-maintained/register/esm tests/standalone/rosetta_jane_live.standalone.ts <url> <token>
// Prints one JSON line. Rosetta-Jane's own test suite runs this when NOMAD's code is present.
import {
  RosettaJaneClient,
  describeSwarm,
  parseTrainingPairs,
  trialItems,
} from '../../app/utils/rosetta_jane.js'

const [url, token] = process.argv.slice(2)
const out: Record<string, unknown> = {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const watcher = new RosettaJaneClient(url)
const client = new RosettaJaneClient(url, token)

const first = await client.status()
out.model = first.model
out.health = describeSwarm(first).level
out.service_before = first.service

out.without_token = await watcher.setService({ on: false }).then(() => 'allowed', message)
out.wrong_token = await new RosettaJaneClient(url, 'nope')
  .checkToken()
  .then(() => 'allowed', message)
await client.checkToken()

out.service_off = await client.setService({ on: false })
out.service_on = await client.setService({ on: true, training: true })

const file = Array.from({ length: 8 }, (_, i) =>
  JSON.stringify({ question: `w${i} w${i + 3} w${i + 9}`, answer: `w${i + 1} w${i + 2} w${i + 5}` })
).join('\n')
const { pairs } = parseTrainingPairs(file + '\nnot json')
out.pairs = pairs.length
const started = await client.startTraining({ pairs, name: 'from-nomad', epochs: 1 })
out.started = started?.state
out.second_run = await client
  .startTraining({ pairs, name: 'other', epochs: 1 })
  .then(() => 'allowed', message)

let job = started
for (
  let i = 0;
  i < 600 && job && ['starting', 'running', 'stopping', 'scoring'].includes(job.state);
  i++
) {
  await sleep(200)
  job = (await client.status()).training
}
out.finished = job

const last = await client.status()
out.adapters = last.adapters
const zip = new Uint8Array(await client.downloadAdapter('from-nomad'))
out.zip_magic = String.fromCharCode(zip[0], zip[1])
out.zip_bytes = zip.length
out.score_card = await client.scoreCard('from-nomad')
out.zip_without_token = await watcher.downloadAdapter('from-nomad').then(() => 'allowed', message)
out.zip_missing = await client.downloadAdapter('never-made').then(() => 'allowed', message)

// Someone else's adapter: add it, try it on a list and in a chat, score it on our own pairs.
const settle = async () => {
  for (let i = 0; i < 600; i++) {
    const current = (await client.status()).adapterJob
    if (current && current.state !== 'running') return current
    await sleep(200)
  }
  return null
}
await client.importAdapter('shared-copy', zip)
out.import_twice = await client.importAdapter('shared-copy', zip).then(() => 'allowed', message)
out.details = (await client.status()).adapterDetails
await client.tryAdapter('shared-copy', trialItems(['w3 w9 w20 w41', 'w5 w7']), 5)
out.trial_list = await settle()
const firstTurn = (out.trial_list as any).answers[0]
await client.tryAdapter(
  'shared-copy',
  trialItems(
    ['w11 w12'],
    [{ question: 'w3 w9 w20 w41', without: firstTurn.without, with: firstTurn.with }]
  ),
  5
)
out.trial_chat = await settle()
await client.scoreAdapter('shared-copy', pairs)
out.scored = await settle()
out.my_card = await client.scoreCard('shared-copy')

console.log(JSON.stringify(out))
