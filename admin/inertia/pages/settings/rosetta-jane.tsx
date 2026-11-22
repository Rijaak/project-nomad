import { Head } from '@inertiajs/react'
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import SettingsLayout from '~/layouts/SettingsLayout'
import StyledButton from '~/components/StyledButton'
import StyledSectionHeader from '~/components/StyledSectionHeader'
import Alert from '~/components/Alert'
import Input from '~/components/inputs/Input'
import Select from '~/components/inputs/Select'
import Switch from '~/components/inputs/Switch'
import { useNotifications } from '~/context/NotificationContext'
import api from '~/lib/api'
import type { RosettaOverview } from '../../../types/rosetta_jane'
import {
  ROSETTA_DEFAULT_URL,
  describeScore,
  describeSwarm,
  isTrainingActive,
  layerRanges,
  runNameFrom,
  trainingPercent,
} from '../../../app/utils/rosetta_jane'

const OVERVIEW_KEY = ['rosetta-jane', 'overview']

const EPOCH_OPTIONS = [
  { value: '1', label: '1 pass — quick trial' },
  { value: '3', label: '3 passes — recommended' },
  { value: '5', label: '5 passes — small sets of pairs' },
]

const TRAINING_STATE_LABELS: Record<string, string> = {
  starting: 'Starting',
  running: 'Training',
  stopping: 'Stopping',
  scoring: 'Scoring the result',
  stopped: 'Stopped',
  done: 'Finished',
  failed: 'Stopped with a problem',
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm text-text-muted">{label}</p>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
    </div>
  )
}

export default function RosettaJanePage(props: { rosetta: RosettaOverview }) {
  const { addNotification } = useNotifications()
  const queryClient = useQueryClient()

  const [url, setUrl] = useState(props.rosetta.url || '')
  const [token, setToken] = useState('')
  const [connectError, setConnectError] = useState<string | null>(null)
  const [pairsFile, setPairsFile] = useState<File | null>(null)
  const [runName, setRunName] = useState('')
  const [epochs, setEpochs] = useState('3')
  const [trainError, setTrainError] = useState<string | null>(null)
  // Trying and scoring adapters, your own or ones other people shared. A trial never applies anything.
  const [trialOf, setTrialOf] = useState<string | null>(null)
  const [trialMode, setTrialMode] = useState('list')
  const [trialLength, setTrialLength] = useState('64')
  const [trialText, setTrialText] = useState('')
  const [trialTurns, setTrialTurns] = useState<
    { question: string; without: string; with: string }[]
  >([])
  const [pendingQuestions, setPendingQuestions] = useState<string[]>([])
  const [scoringName, setScoringName] = useState<string | null>(null)
  const [sharedFile, setSharedFile] = useState<File | null>(null)
  const [sharedName, setSharedName] = useState('')
  const scorePairsInput = useRef<HTMLInputElement>(null)
  const sharedInput = useRef<HTMLInputElement>(null)
  const [scoreCards, setScoreCards] = useState<
    Record<string, { lines: string[]; shareText: string }>
  >({})

  async function showScoreCard(name: string) {
    try {
      const card = await api.getRosettaScoreCard(name)
      setScoreCards((cards) => ({ ...cards, [name]: card }))
    } catch (error: any) {
      addNotification({
        message: error?.message || 'Could not read the score card.',
        type: 'error',
      })
    }
  }

  async function copyScoreCard(name: string) {
    try {
      await navigator.clipboard.writeText(scoreCards[name].shareText)
      addNotification({
        message: 'Score card copied. Paste it wherever your group talks.',
        type: 'success',
      })
    } catch {
      addNotification({
        message: 'Could not copy. Select the text and copy it by hand.',
        type: 'error',
      })
    }
  }
  const fileInput = useRef<HTMLInputElement>(null)

  // The swarm changes by the minute (serving peers come and go, a run advances), so
  // the page keeps itself current: quickly while a run is going, slowly otherwise.
  const { data } = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => api.getRosettaOverview(),
    initialData: props.rosetta,
    refetchInterval: (query) =>
      isTrainingActive(query.state.data?.status?.training ?? null) ||
      query.state.data?.status?.adapterJob?.state === 'running'
        ? 2000
        : 15000,
    refetchOnWindowFocus: true,
  })
  const overview = data ?? props.rosetta
  const status = overview.status
  const connected = !!overview.url
  const canControl = connected && overview.hasToken && !!status?.controls
  const training = status?.training ?? null
  const trainingActive = isTrainingActive(training)
  const health = status ? describeSwarm(status) : null

  const refresh = () => queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })

  const fail = (error: any) =>
    addNotification({
      message: error?.message || 'Something went wrong. Please try again.',
      type: 'error',
    })

  const adapterJob = status?.adapterJob ?? null
  const adapterBusy = adapterJob?.state === 'running'
  // What the trial panel shows: finished chat turns, then the questions now being answered.
  const liveAnswers =
    adapterJob?.kind === 'try' && adapterJob.name === trialOf ? adapterJob.answers : []
  const shownTurns = [
    ...trialTurns,
    ...pendingQuestions.map((question, i) => ({
      question,
      without: liveAnswers[i]?.without ?? '',
      with: liveAnswers[i]?.with ?? '',
    })),
  ]

  function openTrial(name: string) {
    setTrialOf(trialOf === name ? null : name)
    setTrialTurns([])
    setPendingQuestions([])
    setTrialText('')
  }

  function pickPairsToScore(name: string) {
    setScoringName(name)
    scorePairsInput.current?.click()
  }

  const tryMutation = useMutation({
    mutationFn: async () => {
      const questions =
        trialMode === 'list'
          ? trialText
              .split('\n')
              .map((q) => q.trim())
              .filter(Boolean)
          : [trialText.trim()]
      // A chat carries what each side said before; a list starts every question fresh.
      const history = trialMode === 'chat' ? shownTurns.filter((t) => t.without || t.with) : []
      setTrialTurns(history)
      setPendingQuestions(questions)
      await api.tryRosettaAdapter(trialOf!, questions, history, Number(trialLength))
    },
    onSuccess: () => {
      setTrialText('')
      refresh()
    },
    onError: (error: any) => {
      setPendingQuestions([])
      fail(error)
    },
  })

  const scoreMutation = useMutation({
    mutationFn: ({ file, name }: { file: File; name: string }) =>
      api.scoreRosettaAdapter(file, name),
    onSuccess: () => {
      addNotification({
        message: 'Scoring on your questions. This runs through the group.',
        type: 'success',
      })
      refresh()
    },
    onError: fail,
  })

  const importMutation = useMutation({
    mutationFn: () => api.importRosettaAdapter(sharedFile!, runNameFrom(sharedName)),
    onSuccess: (result) => {
      addNotification({ message: result?.message || 'Adapter added.', type: 'success' })
      setSharedFile(null)
      setSharedName('')
      if (sharedInput.current) sharedInput.current.value = ''
      refresh()
    },
    onError: fail,
  })

  const connectMutation = useMutation({
    mutationFn: () => api.connectRosetta(url.trim(), token.trim() || null),
    onSuccess: () => {
      setConnectError(null)
      setToken('')
      addNotification({ message: 'Connected to Rosetta-Jane.', type: 'success' })
      refresh()
    },
    onError: (error: any) =>
      setConnectError(error?.message || 'Could not connect to Rosetta-Jane.'),
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      // Chat must not keep pointing at a gateway NOMAD has been told to forget.
      if (overview.usedForChat) await api.configureRemoteOllama(null)
      return api.disconnectRosetta()
    },
    onSuccess: () => {
      setUrl('')
      addNotification({ message: 'Rosetta-Jane disconnected.', type: 'success' })
      refresh()
    },
    onError: fail,
  })

  const useForChatMutation = useMutation({
    mutationFn: async (use: boolean) => {
      if (!use) return api.configureRemoteOllama(null)
      // The swarm cannot index documents, so the knowledge base has to stay on
      // this machine. Set first: it also keeps the local AI Assistant running.
      await api.updateSetting('rag.localEmbeddings', true)
      return api.configureRemoteOllama(overview.url)
    },
    onSuccess: (_result, use) => {
      addNotification({
        message: use
          ? 'Chat now answers through the Rosetta-Jane swarm.'
          : 'Chat no longer uses the Rosetta-Jane swarm.',
        type: 'success',
      })
      refresh()
    },
    onError: fail,
  })

  const serviceMutation = useMutation({
    mutationFn: (change: { on?: boolean; training?: boolean }) =>
      api.setRosettaServiceState(change),
    onSuccess: refresh,
    onError: fail,
  })

  const trainMutation = useMutation({
    mutationFn: () =>
      api.startRosettaTraining(
        pairsFile!,
        runNameFrom(runName || pairsFile!.name.replace(/\.[^.]+$/, '')),
        Number(epochs)
      ),
    onSuccess: (result) => {
      setTrainError(null)
      setPairsFile(null)
      if (fileInput.current) fileInput.current.value = ''
      addNotification({
        message: result?.problems?.length
          ? `Training started. Some lines were skipped: ${result.problems.join(' ')}`
          : 'Training started.',
        type: result?.problems?.length ? 'info' : 'success',
      })
      refresh()
    },
    onError: (error: any) => setTrainError(error?.message || 'Training could not be started.'),
  })

  const stopMutation = useMutation({
    mutationFn: () => api.stopRosettaTraining(),
    onSuccess: () => {
      addNotification({
        message: 'Stopping after the current step. Progress is saved.',
        type: 'success',
      })
      refresh()
    },
    onError: fail,
  })

  return (
    <SettingsLayout>
      <Head title="Rosetta-Jane | Project NOMAD" />
      <div className="xl:pl-72 w-full">
        <main className="px-12 py-6">
          <h1 className="text-4xl font-semibold mb-4">Rosetta-Jane</h1>
          <p className="text-text-muted mb-4">
            Share the work of running, training, and testing AI models across a group of devices,
            with no central server. As a community, build models you could not train alone, and take
            the result offline. Or stay connected and pool processing power to run models too big
            for one machine. Bring phones into the same swarm with the Android app. Rosetta-Jane
            splits one model across a group: this machine keeps the first and last layers, and
            devices you are grouped with run the rest.
          </p>
          <Alert
            title="This sends data to other people's devices"
            message="NOMAD normally keeps everything on this machine. Rosetta-Jane does the opposite: every device that helps receives an encoded form of your whole question or training text, which can be turned back into an approximation of it. Use a group code shared only with people you trust, and keep private chats and files on this machine with the Local Only and Private options."
            type="warning"
            variant="bordered"
            className="mb-2"
          />

          <StyledSectionHeader title="Connection" className="mt-8 mb-4" />
          <div className="bg-surface-primary rounded-lg border-2 border-border-subtle p-6">
            <p className="text-sm text-text-secondary mb-4">
              Rosetta-Jane runs as its own program, usually on this same machine. Start it with{' '}
              <code className="bg-surface-secondary px-1 rounded">
                rosetta_jane gateway --controls --api 0.0.0.0:11435
              </code>{' '}
              and enter its address here. The group code and the model are chosen when it is
              started. The control token is saved by the gateway in its work folder, in a file named{' '}
              <code className="bg-surface-secondary px-1 rounded">control-token</code>; without it
              this page can watch the swarm but not change anything.
            </p>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Input
                  name="rosettaUrl"
                  label="Rosetta-Jane Gateway URL"
                  placeholder={ROSETTA_DEFAULT_URL}
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value)
                    setConnectError(null)
                  }}
                />
              </div>
              <div className="flex-1">
                <Input
                  name="rosettaToken"
                  label="Control Token"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    overview.hasToken ? 'Saved — enter a new one to replace it' : 'Optional'
                  }
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value)
                    setConnectError(null)
                  }}
                />
              </div>
              <StyledButton
                variant="primary"
                onClick={() => connectMutation.mutate()}
                loading={connectMutation.isPending}
                disabled={connectMutation.isPending || !url.trim()}
                className="mb-0.5"
              >
                Save &amp; Test
              </StyledButton>
              {connected && (
                <StyledButton
                  variant="danger"
                  onClick={() => disconnectMutation.mutate()}
                  loading={disconnectMutation.isPending}
                  disabled={disconnectMutation.isPending}
                  className="mb-0.5"
                >
                  Clear
                </StyledButton>
              )}
            </div>
            {connectError && <p className="text-sm text-red-600 mt-2">{connectError}</p>}
            {connected && overview.error && (
              <Alert
                title="Rosetta-Jane is not responding"
                message={overview.error}
                type="error"
                variant="bordered"
                className="mt-4"
              />
            )}
            {connected && status && !canControl && (
              <p className="text-sm text-text-muted mt-3">
                {status.controls
                  ? 'No control token is saved, so serving and training cannot be changed from this page.'
                  : 'This gateway was started without --controls, so serving and training cannot be changed from this page.'}
              </p>
            )}
          </div>

          {status && health && (
            <>
              <StyledSectionHeader title="Swarm" className="mt-8 mb-4" />
              <div className="bg-surface-primary rounded-lg border-2 border-border-subtle p-6">
                <Alert
                  title={health.headline}
                  message={health.detail}
                  type={health.level === 'ok' ? 'success' : health.level}
                  variant="bordered"
                  className="mb-6"
                />
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
                  <Fact label="Model" value={status.model} />
                  <Fact label="Peers Running the P2P Service" value={status.peersServing} />
                  <Fact
                    label="Layers Kept on This Machine"
                    value={`${status.ownLayers} of ${status.layers}`}
                  />
                  <Fact
                    label="Layers No Peer Is Serving"
                    value={status.layersMissing.length ? layerRanges(status.layersMissing) : 'None'}
                  />
                  <Fact
                    label="Results Compared Between Devices"
                    value={
                      status.checks.comparePeers === 'auto'
                        ? 'Automatic'
                        : status.checks.comparePeers >= 2
                          ? 'On'
                          : 'Off'
                    }
                  />
                  <Fact
                    label="Known-Answer Tests"
                    value={status.checks.knownAnswers ? 'Ready' : 'Not prepared'}
                  />
                  <Fact
                    label="Rechecking on This Machine"
                    value={status.checks.recheckHere ? 'On' : 'Off'}
                  />
                  <Fact label="Devices Blocked" value={status.peersBlocked} />
                </div>
                {status.lastAnswer && (
                  <p className="text-sm text-text-muted mt-6">
                    Last reply used {status.lastAnswer.peersUsed} device
                    {status.lastAnswer.peersUsed === 1 ? '' : 's'}: {status.lastAnswer.checkedSteps}{' '}
                    steps checked, {status.lastAnswer.uncheckedSteps} not checked.
                  </p>
                )}
                <div className="mt-6 border-t border-border-subtle pt-4">
                  <Switch
                    checked={overview.usedForChat}
                    disabled={
                      useForChatMutation.isPending || (!overview.usedForChat && !status.canAnswer)
                    }
                    onChange={(use) => useForChatMutation.mutate(use)}
                    label="Answer Chats Through the Swarm"
                    description="Sets Rosetta-Jane as the remote AI server for chat. Your questions, and any knowledge base passages sent with them, travel to the devices in your group. Reading and indexing knowledge base files stays on this machine, since the swarm cannot do that part, and chats set to Local Only still never leave it. Replies are slower than a model running here: every word makes a round trip through each device."
                  />
                  {overview.usedForChat && !overview.localEmbeddings && (
                    <Alert
                      title="Knowledge base indexing is set to use the remote server"
                      message="The swarm cannot index documents, so uploads to the Knowledge Base will fail until 'Index the Knowledge Base on This Machine' is turned on in the AI Assistant settings."
                      type="warning"
                      variant="bordered"
                      className="mt-3"
                    />
                  )}
                </div>
              </div>

              <StyledSectionHeader title="P2P Service" className="mt-8 mb-4" />
              <div className="bg-surface-primary rounded-lg border-2 border-border-subtle p-6">
                <Alert
                  title="Before you run the P2P service"
                  type="warning"
                  variant="bordered"
                  className="mb-4"
                >
                  <ul className="list-disc pl-5 space-y-1 text-sm">
                    <li>
                      The P2P service is safest inside a group code, where every peer is someone you
                      chose. On the public network, use is open to anyone.
                    </li>
                    <li>
                      Open P2P runs strangers' prompts. This machine computes layers for whatever
                      anyone on the network asks, and cannot see or filter what that is.
                    </li>
                    <li>
                      This machine never sees the text. It receives processed numbers from partway
                      through the model, not words, and does not save them. That is not a strong
                      privacy guarantee for the person asking, and it does not tell you what this
                      machine helped answer.
                    </li>
                    <li>
                      This machine is reachable from the internet. The service needs an open port
                      (7700 by default) or a tunnel. Traffic is encrypted, but a bug in the program
                      could expose the machine. A mesh VPN such as Tailscale together with a group
                      code avoids an open port.
                    </li>
                    <li>It uses this machine's hardware, power and bandwidth whenever it is on.</li>
                    <li>
                      No warranty. Rosetta-Jane is a separate program, provided as is under the GNU
                      AGPL version 3.
                    </li>
                  </ul>
                </Alert>
                {status.service ? (
                  <div className="space-y-4">
                    <Switch
                      checked={status.service.on}
                      disabled={!canControl || serviceMutation.isPending}
                      onChange={(on) => serviceMutation.mutate({ on })}
                      label="Run the P2P Service on This Machine"
                      description={`Runs layers ${status.service.layers[0]}-${status.service.layers[1] - 1} of the model for other people in your group while Rosetta-Jane is running. This machine cannot see what it is helping to answer. It uses real electricity and keeps a port open; turn it off whenever you need the hardware for yourself.`}
                    />
                    <Switch
                      checked={status.service.training}
                      disabled={!canControl || !status.service.on || serviceMutation.isPending}
                      onChange={(help) => serviceMutation.mutate({ training: help })}
                      label="Also Help Others Train"
                      description="Lets people in your group use this machine for training as well as answering. Training is heavier and longer-running work, so it is off unless you choose it."
                    />
                    <p className="text-sm text-text-muted">
                      Helped so far since Rosetta-Jane was started: {status.service.stepsHelped}{' '}
                      answer steps and {status.service.examplesHelped} training examples.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-text-secondary">
                    This gateway was started without layers to serve. To run the p2p service here,
                    start it with{' '}
                    <code className="bg-surface-secondary px-1 rounded">--serve FIRST:END</code>,
                    for example{' '}
                    <code className="bg-surface-secondary px-1 rounded">--serve 8:16</code> to serve
                    layers 8 to 15.
                  </p>
                )}
              </div>

              <StyledSectionHeader title="Training" className="mt-8 mb-4" />
              <div className="bg-surface-primary rounded-lg border-2 border-border-subtle p-6">
                <p className="text-sm text-text-secondary mb-4">
                  <strong>Build a better model, together.</strong> Don&apos;t be limited by personal
                  hardware. Pool your machines as a community to teach a model what we all need it
                  to know. When training is done, download the result, score it, and use it offline.
                  The network is only needed while training and scoring.
                </p>
                <p className="text-sm text-text-secondary mb-4">
                  You teach the model from question and answer pairs. This machine keeps every
                  trained weight and decides each update; other devices only do calculations and
                  hand the results back. Devices that help can see an encoded form of your pairs, so
                  do not train on private material with people you do not trust.
                </p>

                {training && (
                  <div className="mb-6 rounded-lg border border-border-subtle p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-lg font-semibold">
                        {training.name}{' '}
                        <span className="text-sm font-normal text-text-muted">
                          — {TRAINING_STATE_LABELS[training.state] ?? training.state}
                        </span>
                      </p>
                      {trainingActive && (
                        <StyledButton
                          variant="danger"
                          size="sm"
                          onClick={() => stopMutation.mutate()}
                          loading={stopMutation.isPending || training.state === 'stopping'}
                          disabled={
                            !canControl || stopMutation.isPending || training.state === 'stopping'
                          }
                        >
                          Stop
                        </StyledButton>
                      )}
                    </div>
                    <div className="relative w-full h-2 bg-border-subtle rounded">
                      <div
                        className="absolute top-0 left-0 h-full bg-desert-green rounded"
                        style={{ width: `${trainingPercent(training)}%` }}
                      />
                    </div>
                    <p className="text-sm text-text-muted mt-2">
                      Step {training.step} of {training.totalSteps} · {training.pairs} pairs
                      {training.loss !== null ? ` · loss ${training.loss.toFixed(3)}` : ''} ·{' '}
                      {training.checked} pieces of work checked, {training.unchecked} not checked
                      {training.peersBlocked ? ` · ${training.peersBlocked} devices blocked` : ''}
                    </p>
                    {training.pairsKeptBack > 0 && !training.score && (
                      <p className="text-sm text-text-muted mt-1">
                        {training.pairsKeptBack} more pair
                        {training.pairsKeptBack === 1 ? ' is' : 's are'} kept back and never trained
                        on, to score the result with.
                      </p>
                    )}
                    {training.score && (
                      <p className="text-sm text-text-primary mt-2">
                        {describeScore(training.score)}
                      </p>
                    )}
                    {training.pairsCutShort > 0 && (
                      <p className="text-sm text-text-muted mt-1">
                        {training.pairsCutShort} pairs were longer than the limit and were cut
                        short.
                      </p>
                    )}
                    {training.error && (
                      <p className="text-sm text-red-600 mt-2">{training.error}</p>
                    )}
                    {training.state === 'stopped' && (
                      <p className="text-sm text-text-muted mt-2">
                        Progress is saved. Start a run with the same name and the same file to carry
                        on.
                      </p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-end">
                  <div>
                    <label
                      htmlFor="rosettaPairs"
                      className="block text-base/6 font-medium text-text-primary"
                    >
                      Question and Answer Pairs
                    </label>
                    <input
                      id="rosettaPairs"
                      ref={fileInput}
                      type="file"
                      accept=".jsonl,.json,.txt"
                      disabled={!canControl || trainingActive}
                      onChange={(e) => {
                        setPairsFile(e.target.files?.[0] ?? null)
                        setTrainError(null)
                      }}
                      className="mt-1.5 block w-full text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-surface-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-text-primary"
                    />
                  </div>
                  <Input
                    name="rosettaRunName"
                    label="Name for This Run"
                    placeholder="my-first-run"
                    value={runName}
                    disabled={!canControl || trainingActive}
                    onChange={(e) => setRunName(e.target.value)}
                  />
                  <Select
                    name="rosettaEpochs"
                    label="Passes Over Your Pairs"
                    value={epochs}
                    options={EPOCH_OPTIONS}
                    disabled={!canControl || trainingActive}
                    onChange={(value) => setEpochs(value)}
                  />
                </div>
                <p className="text-sm text-text-muted mt-2">
                  One pair per line, as{' '}
                  <code className="bg-surface-secondary px-1 rounded">
                    {'{"question": "...", "answer": "..."}'}
                  </code>
                  . Training needs devices in your group that have chosen to help others train.
                </p>
                {trainError && <p className="text-sm text-red-600 mt-2">{trainError}</p>}
                <StyledButton
                  variant="primary"
                  className="mt-4"
                  onClick={() => trainMutation.mutate()}
                  loading={trainMutation.isPending}
                  disabled={!canControl || trainingActive || !pairsFile || trainMutation.isPending}
                >
                  Start Training
                </StyledButton>
              </div>

              <StyledSectionHeader title="Trained Adapters" className="mt-8 mb-4" />
              <div className="bg-surface-primary rounded-lg border-2 border-border-subtle p-6">
                <Alert
                  title="Finished training is never applied for you"
                  message="A trained adapter changes how the model answers, and part of the work was done on other people's devices. NOMAD and Rosetta-Jane will not switch one on. Download it, read the note inside, score it on questions it never saw, and apply it yourself only if you are satisfied. Each adapter is its own decision. If you build on Rosetta-Jane, keep this step. Removing it trades a minute of someone's attention for the one safeguard that does not depend on the network behaving."
                  type="info"
                  variant="bordered"
                  className="mb-4"
                />
                {canControl && (
                  <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
                    <p className="text-sm text-text-muted max-w-2xl">
                      Model Adapter Score is one landscape page with every score held here: each
                      adapter beside the unchanged model, arranged by model, then by adapter, best
                      first. It is a file for you to keep and is sent nowhere.
                    </p>
                    <a href="/api/rosetta-jane/model-adapter-score" download="Model Adapter Score.html">
                      <StyledButton variant="outline" icon="IconDownload">
                        Model Adapter Score
                      </StyledButton>
                    </a>
                  </div>
                )}
                {status.adapterDetails.length === 0 ? (
                  <p className="text-sm text-text-muted">No adapters yet.</p>
                ) : (
                  <ul className="divide-y divide-border-subtle">
                    {status.adapterDetails.map((adapter) => (
                      <li key={adapter.name} className="py-3">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div>
                            <p className="text-lg font-semibold">{adapter.name}</p>
                            <p className="text-sm text-text-muted">
                              {adapter.received
                                ? 'Shared with you by someone else.'
                                : 'Trained through this gateway.'}{' '}
                              {adapter.myScore
                                ? 'You have scored it on your own questions.'
                                : adapter.scored
                                  ? 'Scored by the run that trained it.'
                                  : 'Not scored yet.'}
                            </p>
                          </div>
                          {canControl ? (
                            <div className="flex items-center gap-2 flex-wrap">
                              <StyledButton
                                variant={trialOf === adapter.name ? 'primary' : 'outline'}
                                onClick={() => openTrial(adapter.name)}
                              >
                                Try It
                              </StyledButton>
                              <StyledButton
                                variant="outline"
                                disabled={adapterBusy}
                                onClick={() => pickPairsToScore(adapter.name)}
                              >
                                Score on My Questions
                              </StyledButton>
                              <StyledButton
                                variant="outline"
                                onClick={() => showScoreCard(adapter.name)}
                              >
                                Score Card
                              </StyledButton>
                              <a
                                href={`/api/rosetta-jane/adapters/${encodeURIComponent(adapter.name)}`}
                                download={`${adapter.name}.zip`}
                              >
                                <StyledButton variant="secondary" icon="IconDownload">
                                  Download
                                </StyledButton>
                              </a>
                            </div>
                          ) : (
                            <span className="text-sm text-text-muted">Needs the control token</span>
                          )}
                        </div>
                        {adapterJob?.kind === 'score' && adapterJob.name === adapter.name && (
                          <p className="text-sm text-text-muted mt-2">
                            {adapterJob.state === 'running'
                              ? 'Scoring on your questions through the group\u2026'
                              : adapterJob.state === 'failed'
                                ? adapterJob.error
                                : adapterJob.lines.join(' ')}
                          </p>
                        )}
                        {scoreCards[adapter.name] && (
                          <div className="mt-3 rounded-lg border border-border-subtle p-4">
                            {scoreCards[adapter.name].lines.map((line, i) => (
                              <p key={i} className="text-sm text-text-primary">
                                {line}
                              </p>
                            ))}
                            {scoreCards[adapter.name].shareText && (
                              <>
                                <p className="text-sm text-text-muted mt-3">
                                  A score card holds numbers only, never your questions or answers.
                                  It stays here unless you choose to share it, so others can compare
                                  it with their own.
                                </p>
                                <StyledButton
                                  variant="outline"
                                  size="sm"
                                  className="mt-2"
                                  onClick={() => copyScoreCard(adapter.name)}
                                >
                                  Copy to Share
                                </StyledButton>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <input
                  ref={scorePairsInput}
                  type="file"
                  accept=".jsonl,.json,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file && scoringName) scoreMutation.mutate({ file, name: scoringName })
                    e.target.value = ''
                  }}
                />

                {canControl && trialOf && (
                  <div className="mt-6 border-t border-border-subtle pt-4">
                    <p className="text-lg font-semibold">Try &ldquo;{trialOf}&rdquo;</p>
                    <p className="text-sm text-text-muted mb-3">
                      Every question is answered twice: by the unchanged model, and by the model
                      with this adapter. This is a trial. The adapter is not applied to anything,
                      and your chats never use it. Trials are slow, because the whole reply is
                      worked out again for every word, and they need devices that have chosen to
                      help others train.
                    </p>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <Select
                        name="trialMode"
                        label="How to Try It"
                        value={trialMode}
                        options={[
                          { value: 'list', label: 'A list of questions' },
                          { value: 'chat', label: 'A trial chat' },
                        ]}
                        onChange={(value) => {
                          setTrialMode(value)
                          setTrialTurns([])
                        }}
                      />
                      <Select
                        name="trialLength"
                        label="Reply Length"
                        value={trialLength}
                        options={[
                          { value: '64', label: 'Short (about 50 words) \u2014 recommended' },
                          { value: '128', label: 'Medium (about 100 words)' },
                          { value: '256', label: 'Long (about 200 words) \u2014 slow' },
                        ]}
                        onChange={(value) => setTrialLength(value)}
                      />
                    </div>
                    <label
                      htmlFor="trialQuestions"
                      className="block text-base/6 font-medium text-text-primary mt-4"
                    >
                      {trialMode === 'list' ? 'Questions, one per line' : 'Your next message'}
                    </label>
                    <textarea
                      id="trialQuestions"
                      rows={trialMode === 'list' ? 4 : 2}
                      value={trialText}
                      onChange={(e) => setTrialText(e.target.value)}
                      className="mt-1.5 block w-full rounded-md border border-border-default bg-surface-primary p-2 text-sm text-text-primary"
                    />
                    <div className="flex items-center gap-2 mt-3">
                      <StyledButton
                        variant="primary"
                        onClick={() => tryMutation.mutate()}
                        loading={
                          tryMutation.isPending || (adapterBusy && adapterJob?.kind === 'try')
                        }
                        disabled={adapterBusy || tryMutation.isPending || !trialText.trim()}
                      >
                        {trialMode === 'list' ? 'Try These Questions' : 'Send'}
                      </StyledButton>
                      {adapterBusy && (
                        <StyledButton
                          variant="danger"
                          onClick={() => api.stopRosettaAdapterJob().then(refresh)}
                        >
                          Stop
                        </StyledButton>
                      )}
                      {trialMode === 'chat' && trialTurns.length > 0 && !adapterBusy && (
                        <StyledButton variant="ghost" onClick={() => setTrialTurns([])}>
                          Start a New Trial Chat
                        </StyledButton>
                      )}
                    </div>
                    {adapterJob?.kind === 'try' && adapterJob.state === 'failed' && (
                      <p className="text-sm text-red-600 mt-2">{adapterJob.error}</p>
                    )}
                    {adapterJob?.kind === 'try' && adapterJob.state === 'running' && (
                      <p className="text-sm text-text-muted mt-2">
                        Answered {adapterJob.done} of {adapterJob.total}\u2026
                      </p>
                    )}
                    {shownTurns.map((turn, i) => (
                      <div key={i} className="mt-4 rounded-lg border border-border-subtle p-4">
                        <p className="text-sm font-semibold text-text-primary">{turn.question}</p>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-2">
                          <div>
                            <p className="text-sm text-text-muted">Without the adapter</p>
                            <p className="text-sm text-text-primary whitespace-pre-wrap">
                              {turn.without || '\u2026'}
                            </p>
                          </div>
                          <div>
                            <p className="text-sm text-text-muted">With &ldquo;{trialOf}&rdquo;</p>
                            <p className="text-sm text-text-primary whitespace-pre-wrap">
                              {turn.with || '\u2026'}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {canControl && (
                  <div className="mt-6 border-t border-border-subtle pt-4">
                    <p className="text-lg font-semibold">Add an Adapter Someone Shared</p>
                    <p className="text-sm text-text-muted mb-3">
                      Pick the zip someone sent you. It is checked and stored here so you can try it
                      and score it on your own questions. Adding it applies nothing. It only works
                      with the same base model it was trained on.
                    </p>
                    <div className="flex items-end gap-3 flex-wrap">
                      <input
                        type="file"
                        accept=".zip"
                        ref={sharedInput}
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null
                          setSharedFile(file)
                          if (file && !sharedName)
                            setSharedName(runNameFrom(file.name.replace(/\.zip$/i, '')))
                        }}
                        className="block text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-surface-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-text-primary"
                      />
                      <div className="w-64">
                        <Input
                          name="sharedName"
                          label="Name to Keep It Under"
                          value={sharedName}
                          onChange={(e) => setSharedName(e.target.value)}
                        />
                      </div>
                      <StyledButton
                        variant="primary"
                        className="mb-0.5"
                        onClick={() => importMutation.mutate()}
                        loading={importMutation.isPending}
                        disabled={!sharedFile || !sharedName.trim() || importMutation.isPending}
                      >
                        Add Adapter
                      </StyledButton>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </SettingsLayout>
  )
}
