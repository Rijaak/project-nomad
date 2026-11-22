import { readFile } from 'node:fs/promises'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { RosettaJaneService } from '#services/rosetta_jane_service'
import { assertNotCloudMetadataUrl } from '#validators/common'
import {
  rosettaAdapterSchema,
  rosettaNamedUploadSchema,
  rosettaTrySchema,
  rosettaConnectSchema,
  rosettaServiceSchema,
  rosettaTrainSchema,
} from '#validators/rosetta_jane'
import {
  ROSETTA_MAX_FILE_BYTES,
  RosettaError,
  parseTrainingPairs,
  runNameFrom,
  trialItems,
} from '../utils/rosetta_jane.js'

@inject()
export default class RosettaJaneController {
  constructor(private rosetta: RosettaJaneService) {}

  /** Gateway problems are the user's to fix, so they come back as a readable 400 rather than a 500. */
  private fail(response: HttpContext['response'], error: unknown) {
    const message = error instanceof Error ? error.message : 'Rosetta-Jane request failed.'
    return response
      .status(error instanceof RosettaError ? 400 : 500)
      .send({ success: false, message })
  }

  async page({ inertia }: HttpContext) {
    return inertia.render('settings/rosetta-jane', { rosetta: await this.rosetta.overview() })
  }

  async overview() {
    return this.rosetta.overview()
  }

  async connect({ request, response }: HttpContext) {
    const { url, token } = await request.validateUsing(rosettaConnectSchema)
    try {
      assertNotCloudMetadataUrl(url)
    } catch (error) {
      return response
        .status(400)
        .send({ success: false, message: error instanceof Error ? error.message : 'Invalid URL.' })
    }
    try {
      await this.rosetta.connect(url, token || null)
      return { success: true, message: 'Connected to Rosetta-Jane.' }
    } catch (error) {
      return this.fail(response, error)
    }
  }

  async disconnect() {
    await this.rosetta.disconnect()
    return { success: true, message: 'Rosetta-Jane disconnected.' }
  }

  async service({ request, response }: HttpContext) {
    const change = await request.validateUsing(rosettaServiceSchema)
    try {
      const client = await this.rosetta.client()
      const service = await client.setService(change)
      return { success: true, service }
    } catch (error) {
      return this.fail(response, error)
    }
  }

  async train({ request, response }: HttpContext) {
    const { name, epochs } = await request.validateUsing(rosettaTrainSchema)
    const upload = request.file('file', { size: ROSETTA_MAX_FILE_BYTES })
    if (!upload || !upload.tmpPath) {
      return response
        .status(400)
        .send({ success: false, message: 'Choose a file of question and answer pairs.' })
    }
    if (!upload.isValid) {
      return response.status(400).send({
        success: false,
        message: upload.errors[0]?.message ?? 'That file could not be used.',
      })
    }
    // Parsed and checked here, so the browser and the gateway are never the only
    // things standing between a bad file and a run.
    const { pairs, problems } = parseTrainingPairs(await readFile(upload.tmpPath, 'utf8'))
    if (pairs.length === 0) {
      return response.status(400).send({
        success: false,
        message: `No question and answer pairs were found. ${problems.join(' ')}`.trim(),
      })
    }
    try {
      const client = await this.rosetta.client()
      const training = await client.startTraining({
        pairs,
        name: runNameFrom(name),
        epochs,
      })
      return { success: true, training, problems }
    } catch (error) {
      return this.fail(response, error)
    }
  }

  async stopTraining({ response }: HttpContext) {
    try {
      const client = await this.rosetta.client()
      const training = await client.stopTraining()
      return { success: true, training }
    } catch (error) {
      return this.fail(response, error)
    }
  }

  /** Add an adapter someone shared (the zip they downloaded). Storing it applies nothing. */
  async importAdapter({ request, response }: HttpContext) {
    const { name } = await request.validateUsing(rosettaNamedUploadSchema)
    const upload = request.file('file', { size: '512mb', extnames: ['zip'] })
    if (!upload || !upload.tmpPath || !upload.isValid) {
      return response.status(400).send({
        success: false,
        message:
          upload?.errors[0]?.message ?? 'Choose the zip of an adapter someone shared with you.',
      })
    }
    try {
      const client = await this.rosetta.client()
      await client.importAdapter(runNameFrom(name), new Uint8Array(await readFile(upload.tmpPath)))
      return {
        success: true,
        message: 'Adapter added. Try it and score it before deciding to use it.',
      }
    } catch (error) {
      return this.fail(response, error)
    }
  }

  /** Score an adapter on the user's own question and answer pairs. */
  async scoreAdapter({ request, response }: HttpContext) {
    const { name } = await request.validateUsing(rosettaNamedUploadSchema)
    const upload = request.file('file', { size: ROSETTA_MAX_FILE_BYTES })
    if (!upload || !upload.tmpPath || !upload.isValid) {
      return response.status(400).send({
        success: false,
        message:
          upload?.errors[0]?.message ?? 'Choose a file of question and answer pairs to score with.',
      })
    }
    const { pairs, problems } = parseTrainingPairs(await readFile(upload.tmpPath, 'utf8'))
    if (pairs.length === 0) {
      return response.status(400).send({
        success: false,
        message: `No question and answer pairs were found. ${problems.join(' ')}`.trim(),
      })
    }
    try {
      const client = await this.rosetta.client()
      await client.scoreAdapter(runNameFrom(name), pairs)
      return { success: true, problems }
    } catch (error) {
      return this.fail(response, error)
    }
  }

  /**
   * Try an adapter: every question is answered twice, without the adapter and with it.
   * A trial never applies the adapter to anything, and NOMAD's chat never uses one.
   */
  async tryAdapter({ request, response }: HttpContext) {
    const { name, questions, history, maxNew } = await request.validateUsing(rosettaTrySchema)
    try {
      const client = await this.rosetta.client()
      await client.tryAdapter(name, trialItems(questions, history ?? []), maxNew)
      return { success: true }
    } catch (error) {
      return this.fail(response, error)
    }
  }

  async stopAdapterJob({ response }: HttpContext) {
    try {
      const client = await this.rosetta.client()
      await client.stopAdapterJob()
      return { success: true }
    } catch (error) {
      return this.fail(response, error)
    }
  }

  /**
   * The Model Adapter Score document, as a file to keep. It is written by the gateway, which may be
   * another machine, so it is sent as a download with a policy that lets it run nothing: it is
   * never rendered as part of NOMAD.
   */
  async scoreDocument({ response }: HttpContext) {
    try {
      const client = await this.rosetta.client()
      const page = await client.scoreDocument()
      response.header('Content-Type', 'text/html; charset=utf-8')
      response.header('Content-Disposition', 'attachment; filename="Model Adapter Score.html"')
      response.header(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; style-src 'unsafe-inline'"
      )
      response.header('X-Content-Type-Options', 'nosniff')
      return response.send(page)
    } catch (error) {
      return this.fail(response, error)
    }
  }

  /** The score card for a finished adapter, as lines to show and text the user may choose to share. */
  async scoreCard({ request, response }: HttpContext) {
    const { name } = await rosettaAdapterSchema.validate({ name: request.param('name') })
    try {
      const client = await this.rosetta.client()
      return await client.scoreCard(name)
    } catch (error) {
      return this.fail(response, error)
    }
  }

  /**
   * Hand a finished adapter to the browser as a file. This is the whole of what
   * NOMAD does with a trained adapter: it is never loaded or applied here.
   * If you build on this page, keep it that way.
   */
  async downloadAdapter({ request, response }: HttpContext) {
    const { name } = await rosettaAdapterSchema.validate({ name: request.param('name') })
    try {
      const client = await this.rosetta.client()
      const zip = await client.downloadAdapter(name)
      response.header('Content-Type', 'application/zip')
      response.header('Content-Disposition', `attachment; filename="${name}.zip"`)
      return response.send(Buffer.from(zip))
    } catch (error) {
      return this.fail(response, error)
    }
  }
}
