import KVStore from '#models/kv_store'
import type { RosettaOverview } from '../../types/rosetta_jane.js'
import { normalizeBaseUrl } from '../utils/ai_backend.js'
import { RosettaError, RosettaJaneClient } from '../utils/rosetta_jane.js'

/**
 * NOMAD's side of Rosetta-Jane, the peer-to-peer backend that answers and
 * trains through other people's devices.
 *
 * The gateway is a separate program (usually on this same machine) that already
 * looks like an Ollama server, so chat reaches it through the existing remote
 * AI server setting. This service covers what that setting cannot: seeing the
 * swarm, switching serving on and off, and running training.
 */
export class RosettaJaneService {
  async url(): Promise<string | null> {
    return normalizeBaseUrl(await KVStore.getValue('ai.rosettaJaneUrl'))
  }

  async client(): Promise<RosettaJaneClient> {
    const url = await this.url()
    if (!url) throw new RosettaError('Rosetta-Jane is not connected yet.')
    return new RosettaJaneClient(url, (await KVStore.getValue('ai.rosettaJaneToken')) || null)
  }

  /** Test a gateway, and its token when one is given, then remember them. */
  async connect(rawUrl: string, token: string | null): Promise<void> {
    const url = normalizeBaseUrl(rawUrl)
    if (!url) throw new RosettaError('Enter the address of the Rosetta-Jane gateway.')
    const client = new RosettaJaneClient(url, token)
    const status = await client.status()
    if (token) {
      if (!status.controls) {
        throw new RosettaError(
          'This gateway was started without controls, so a token does nothing. Start it with --controls, or leave the token empty to only watch.'
        )
      }
      await client.checkToken()
    }
    await KVStore.setValue('ai.rosettaJaneUrl', url)
    if (token) await KVStore.setValue('ai.rosettaJaneToken', token)
    else await KVStore.clearValue('ai.rosettaJaneToken')
  }

  async disconnect(): Promise<void> {
    await KVStore.clearValue('ai.rosettaJaneUrl')
    await KVStore.clearValue('ai.rosettaJaneToken')
  }

  async overview(): Promise<RosettaOverview> {
    const url = await this.url()
    const hasToken = !!(await KVStore.getValue('ai.rosettaJaneToken'))
    const remoteUrl = normalizeBaseUrl(await KVStore.getValue('ai.remoteOllamaUrl'))
    const base: RosettaOverview = {
      url: url ?? '',
      hasToken,
      status: null,
      error: null,
      usedForChat: !!url && remoteUrl === url,
      localEmbeddings: (await KVStore.getValue('rag.localEmbeddings')) === true,
    }
    if (!url) return base
    try {
      return { ...base, status: await new RosettaJaneClient(url).status() }
    } catch (error) {
      return {
        ...base,
        error: error instanceof Error ? error.message : 'Rosetta-Jane did not answer.',
      }
    }
  }
}
