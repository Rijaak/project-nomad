import vine from '@vinejs/vine'

export const rosettaConnectSchema = vine.compile(
  vine.object({
    url: vine.string().trim().minLength(1).maxLength(500),
    token: vine.string().trim().maxLength(200).nullable().optional(),
  })
)

export const rosettaServiceSchema = vine.compile(
  vine.object({
    on: vine.boolean().optional(),
    training: vine.boolean().optional(),
  })
)

export const rosettaTrainSchema = vine.compile(
  vine.object({
    // The pairs file itself arrives as a multipart upload beside these fields
    // (JSON bodies are capped far below the size of a real training set).
    name: vine.string().trim().minLength(1).maxLength(60),
    epochs: vine.number().min(0.1).max(20),
  })
)

export const rosettaNamedUploadSchema = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(60),
  })
)

export const rosettaTrySchema = vine.compile(
  vine.object({
    name: vine
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    // 'list': separate questions. 'chat': one more turn of a trial chat, with its history.
    questions: vine
      .array(vine.string().trim().minLength(1).maxLength(8000))
      .minLength(1)
      .maxLength(50),
    history: vine
      .array(
        vine.object({
          question: vine.string().maxLength(8000),
          without: vine.string().maxLength(8000),
          with: vine.string().maxLength(8000),
        })
      )
      .maxLength(40)
      .optional(),
    maxNew: vine.number().min(1).max(512),
  })
)

export const rosettaAdapterSchema = vine.compile(
  vine.object({
    name: vine
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  })
)
